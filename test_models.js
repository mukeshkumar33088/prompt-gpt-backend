require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Function to fetch models using native fetch (Node 18+)
async function listModels() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        console.error("No API KEY found!");
        return;
    }

    console.log("Fetching models for key: " + key.substring(0, 10) + "...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;

    try {
        // Native fetch
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Error: ${response.status} ${response.statusText}`);
            const text = await response.text();
            console.error(text);
            return;
        }

        const data = await response.json();
        console.log("--- AVAILABLE MODELS ---");
        if (data.models) {
            data.models.forEach(m => {
                if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')) {
                    console.log(`Name: ${m.name}`); // e.g. models/gemini-pro
                }
            });
        } else {
            console.log("No models returned.");
        }
    } catch (e) {
        console.error("Fetch Error:", e);
    }
}

listModels();
