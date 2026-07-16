require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Your secret API key from the .env file
const API_KEY = process.env.Z_API_KEY;

app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;

    if (!API_KEY) {
        return res.status(500).json({ reply: 'API key is missing on the server.' });
    }

    try {
        // Calling the Zhipu AI (Z.ai) API
        const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'glm-4', // or glm-4-flash for a cheaper/faster option
                messages: [
                    {
                        // This system prompt makes the AI act as your portfolio assistant
                        role: 'system',
                        content: 'You are a helpful assistant representing Tharindu Madhusanka Rajapakshe on his portfolio website. Be professional, concise, and encouraging. Highlight his skills in software development, web development, and his experience. Tell users to contact him via email at tharindu.rajapakshe99@gmail.com for work inquiries. Keep answers brief (1-3 sentences) and highly relevant to his portfolio.'
                    },
                    { role: 'user', content: userMessage }
                ]
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error('API Error Response:', data);
            throw new Error(data.error?.message || 'API error');
        }

        const botReply = data.choices[0].message.content;
        
        res.json({ reply: botReply });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ reply: 'Sorry, I am having trouble connecting to the brain right now!' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
