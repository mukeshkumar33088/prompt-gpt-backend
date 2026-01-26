require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const limitService = require('./limitService');
const paymentService = require('./paymentService');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Configure Multer for Disk Storage (Prevents OOM Crashes on Render)
const uploadDir = '/tmp/uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir)
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
});
const upload = multer({ storage: storage });

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Gemini Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Routes

// 1. Check Limit Endpoint
app.get('/api/limit/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { email } = req.query; // Get email from query params
    const status = await limitService.getLimitStatus(deviceId, email);
    res.json(status);
});

// 1.5 Reward Endpoint (Ad watched)
app.post('/api/reward', (req, res) => {
    const { deviceId } = req.body;
    console.log(`[Reward] Request for device: ${deviceId}`);
    if (!deviceId) {
        return res.status(400).json({ error: "Missing Device ID" });
    }
    const result = limitService.incrementLimit(deviceId);
    console.log(`[Reward] Result:`, result);
    res.json(result);
});

// 1.8 Payment Endpoints
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount } = req.body;
        const order = await paymentService.createOrder(amount);
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/verify-payment', async (req, res) => {
    const { orderId, paymentId, signature, deviceId, duration, email, phone, amount } = req.body;
    const isValid = paymentService.verifyPayment(orderId, paymentId, signature);

    if (isValid) {
        // Use provided duration or default to 30
        const days = duration || 30;

        // Pass payment details to upgradeUser
        const paymentDetails = {
            orderId,
            paymentId,
            email,
            phone,
            amount
        };

        await limitService.upgradeUser(deviceId, days, paymentDetails);
        res.json({ success: true, message: `Premium Activated for ${days} Days` });
    } else {
        res.status(400).json({ success: false, error: "Invalid Signature" });
    }
});

// 2. Generate Prompt Endpoint
app.post('/api/generate', upload.single('image'), async (req, res) => {
    // Determine source of body (multipart vs json)
    // If multipart, req.body fields are flattened. inputs is likely a stringified JSON.
    let { deviceId, category, inputs, adRewardToken, email } = req.body;

    // Parse inputs if it comes as a string (from Multipart)
    if (typeof inputs === 'string') {
        try {
            inputs = JSON.parse(inputs);
        } catch (e) {
            console.error("Failed to parse inputs JSON:", e);
        }
    }

    if (!deviceId || !category || !inputs) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // Check Limit (Bypass if adRewardToken is present)
    const limitStatus = await limitService.getLimitStatus(deviceId, email);

    // If adRewardToken is true, we assume the user watched an ad.
    // Ideally we should verify a real token, but for now we trust the client flag.
    if (adRewardToken) {
        console.log(`[Generate] Bypassing limit for device ${deviceId} due to Ad Reward.`);
        await limitService.incrementLimit(deviceId); // Restore balance so next check passes normally too
    } else if (!limitStatus.allowed) {
        return res.status(403).json({
            error: "Daily limit reached",
            upgrade: true
        });
    }

    try {
        // Construct Prompt based on Category
        let systemInstruction = "";
        let userPrompt = "";

        switch (category.toLowerCase()) {
            case 'email':
                const emailTone = inputs.tone || 'Professional';
                systemInstruction = `You are an expert email copywriter. Generate a ${emailTone.toLowerCase()} email based on the user's details. The tone MUST be ${emailTone.toLowerCase()} - adjust language, formality, and urgency accordingly. Return ONLY the email subject and body.`;
                userPrompt = `Recipient: ${inputs.recipient}\nTopic: ${inputs.topic}\nTone: ${emailTone}\nContext: ${inputs.details || 'None'}`;
                break;
            case 'social':
                systemInstruction = "You are a social media manager. Create an engaging post for the specified platform. Include hashtags and emojis. Return ONLY the post text.";
                userPrompt = `Write a ${inputs.platform} post about ${inputs.topic} targeted at ${inputs.audience || 'General'}.`;
                if (req.file) { // Check for image presence
                    userPrompt += " The post should be based on the content of the attached image. Describe the image and integrate it into the post naturally.";
                }
                break;
            case 'code':
                systemInstruction = "You are a senior software engineer. Generate specific, clean, and commented code for the requested task. Accept input in ANY language (English, Hindi, Hinglish, etc.) and respond in English. Return ONLY the code logic wrapped in markdown blocks.";
                userPrompt = `Language: ${inputs.language}\nTask: ${inputs.task}`;
                break;
            case 'error_solver':
                systemInstruction = "You are an expert debugger. Analyze the provided error image and description. Explain the error and provide a step-by-step solution with code snippets if applicable.";
                userPrompt = `Description: ${inputs.description || 'See attached image'}`;
                break;
            case 'smart_analyze':
                const intent = inputs.intent; // 'create', 'edit', 'error', 'custom'
                const context = inputs.context || '';

                systemInstruction = `
You are an expert Prompt Engineer and Image Analyst. 
Analyze the provided image and the user's intent: "${intent}".
Return a JSON response (without markdown formatting) with the following keys:
1. "analysis": A brief, 1-sentence description of what is in the image.
2. "prompt": A highly optimized, professional text prompt that the user can use in another AI tool (like Midjourney, ChatGPT, or Stable Diffusion) to achieve their goal.
3. "tip": A short, helpful tip related to their goal.

Intent Guidelines:
- If intent is 'create_image': Write a detailed Stable Diffusion/Midjourney prompt to recreate a similar concept.
- If intent is 'edit_image': Write a prompt describing changes or inpainting instructions.
- If intent is 'fix_error': Analyze the code/error in the screenshot. Write a "Meta-Prompt" for ChatGPT that describes the error context, library versions (if visible), and asks for a specific fix.
- If intent is 'custom': Follow this context: ${context}
`;
                userPrompt = `Analyze this image with Intent: ${intent}.`;
                break;

            default:
                systemInstruction = "You are a helpful AI assistant. Generate a high-quality text prompt based on the user input.";
                userPrompt = JSON.stringify(inputs);
        }

        // Call Gemini
        // Using "gemini-flash-latest" which typically points to the stable 1.5 Flash (better quotas)
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: systemInstruction }],
                },
                {
                    role: "model",
                    parts: [{ text: "Understood. I will act as the expert defined above." }],
                },
            ],
        });

        let parts = [{ text: userPrompt }];

        // Add Image if present
        if (req.file) {
            // Read file from disk (since we use diskStorage now)
            const imageBuffer = fs.readFileSync(req.file.path);
            const base64Image = imageBuffer.toString('base64');

            const imagePart = {
                inlineData: {
                    data: base64Image,
                    mimeType: req.file.mimetype,
                },
            };
            parts.push(imagePart);
        }

        const result = await chat.sendMessage(parts);
        const response = await result.response;
        let text = response.text();

        // Increment usage count (only if not ad rewarded)
        if (!adRewardToken) {
            await limitService.incrementLimit(deviceId);
        }

        // Clean up: Delete temp file
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error("Error deleting temp file:", err);
            });
        }

        // --- 3. Return Response (Clean JSON) ---
        // If the category asked for JSON, try to parse it (Gemini sometimes adds markdown blocks)
        if (['smart_analyze'].includes(category.toLowerCase())) {
            try {
                // Remove Markdown blocks (```json ... ```)
                const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```\n([\s\S]*?)\n```/);
                if (jsonMatch) {
                    text = jsonMatch[1];
                }
                const parsed = JSON.parse(text);

                // Fetch updated limit
                const newLimit = await limitService.getLimitStatus(deviceId);

                return res.json({
                    success: true,
                    prompt: parsed.prompt,
                    analysis: parsed.analysis,
                    tip: parsed.tip,
                    remaining: newLimit.remaining
                });
            } catch (e) {
                console.error("JSON Parse Error from Gemini:", e);
                // Fallback -> return raw text as prompt
                const newLimit = await limitService.getLimitStatus(deviceId);
                return res.json({
                    success: true,
                    prompt: text,
                    analysis: "Auto-Analysis Failed",
                    tip: "Check prompt above",
                    remaining: newLimit.remaining
                });
            }
        }

        console.log(`[Generate] Success. Length: ${text.length}`);
        if (!text) {
            console.error("[Generate] Empty response text!");
        }

        let output = { prompt: text };

        const updatedStatus = await limitService.getLimitStatus(deviceId);
        res.json({
            success: true,
            ...output,
            remaining: updatedStatus.remaining
        });

    } catch (error) {
        console.error("Gemini Error:", error);

        // Forward configured status code if available (e.g. 429, 503)
        if (error.status) {
            return res.status(error.status).json({ error: error.message || "Provider Error" });
        }

        res.status(500).json({ error: "Failed to generate prompt. Try again later." });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
