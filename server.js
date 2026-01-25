require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const limitService = require('./limitService');
const paymentService = require('./paymentService');
const multer = require('multer');

// Configure Multer for memory storage
const storage = multer.memoryStorage();
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
    const status = await limitService.getLimitStatus(deviceId);
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

app.post('/api/verify-payment', (req, res) => {
    const { orderId, paymentId, signature, deviceId, duration } = req.body;
    const isValid = paymentService.verifyPayment(orderId, paymentId, signature);

    if (isValid) {
        // Use provided duration or default to 30
        const days = duration || 30;

        limitService.upgradeUser(deviceId, days);
        res.json({ success: true, message: `Premium Activated for ${days} Days` });
    } else {
        res.status(400).json({ success: false, error: "Invalid Signature" });
    }
});

// 2. Generate Prompt Endpoint
app.post('/api/generate', upload.single('image'), async (req, res) => {
    // Determine source of body (multipart vs json)
    // If multipart, req.body fields are flattened. inputs is likely a stringified JSON.
    let { deviceId, category, inputs, adRewardToken } = req.body;

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
    const limitStatus = limitService.getLimitStatus(deviceId);

    // If adRewardToken is true, we assume the user watched an ad.
    // Ideally we should verify a real token, but for now we trust the client flag.
    if (adRewardToken) {
        console.log(`[Generate] Bypassing limit for device ${deviceId} due to Ad Reward.`);
        limitService.incrementLimit(deviceId); // Restore balance so next check passes normally too
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
                systemInstruction = "You are an expert email copywriter. Generate a professional, concise, and effective email based on the user's details. Return ONLY the email subject and body.";
                userPrompt = `Recipient: ${inputs.recipient}\nTopic: ${inputs.topic}\nTone: ${inputs.tone || 'Professional'}\nContext: ${inputs.details || 'None'}`;
                break;
            case 'social':
                systemInstruction = "You are a social media manager. Create an engaging post for the specified platform. Include hashtags and emojis. Return ONLY the post text.";
                userPrompt = `Write a ${inputs.platform} post about ${inputs.topic} targeted at ${inputs.audience || 'General'}.`;
                if (req.file) { // Check for image presence
                    userPrompt += " The post should be based on the content of the attached image. Describe the image and integrate it into the post naturally.";
                }
                break;
            case 'code':
                systemInstruction = "You are a senior software engineer. specific, clean, and commented code for the requested task. Return ONLY the code logic wrapped in markdown blocks.";
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
            const imagePart = {
                inlineData: {
                    data: req.file.buffer.toString('base64'),
                    mimeType: req.file.mimetype,
                },
            };
            parts.push(imagePart);
        }

        const result = await chat.sendMessage(parts);
        const responseCallback = await result.response;
        const text = responseCallback.text();

        console.log(`[Generate] Success. Length: ${text.length}`);
        if (!text) {
            console.error("[Generate] Empty response text!");
        }

        // Decrement Limit after success
        // Only decrement if we actually got text
        if (text && text.length > 0) {
            limitService.decrementLimit(deviceId);
        }

        let output = {};

        // Try to parse JSON for smart_analyze, otherwise use raw text
        if (category === 'smart_analyze') {
            try {
                // Remove Markdown code blocks if present
                const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
                output = JSON.parse(cleanText);
            } catch (e) {
                console.error("Failed to parse Gemini JSON:", e);
                output = { prompt: text, analysis: "Analysis failed", tip: "Try again" };
            }
        } else {
            output = { prompt: text };
        }

        res.json({
            success: true,
            ...output,
            remaining: limitService.getLimitStatus(deviceId).remaining
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
