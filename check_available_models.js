const https = require('https');
require('dotenv').config();

const apiKey = process.env.GEMINI_API_KEY;
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

https.get(url, (res) => {
    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log("Available Models:");
            if (json.models) {
                json.models.forEach(model => {
                    if (model.supportedGenerationMethods && model.supportedGenerationMethods.includes("generateContent")) {
                        console.log(`- ${model.name}`);
                    }
                });
            } else {
                console.log("No models found or error structure:", json);
            }
        } catch (e) {
            console.error("Error parsing response:", e.message);
            console.log("Raw Response:", data);
        }
    });

}).on("error", (err) => {
    console.log("Error: " + err.message);
});
