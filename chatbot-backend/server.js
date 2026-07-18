require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const mongoose = require('mongoose');
const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// MONGODB CONNECTION
// ============================================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/portfolio_analytics';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));

// ============================================================
// MONGODB SCHEMAS & MODELS
// ============================================================
const visitSchema = new mongoose.Schema({
    ip: String,
    userAgent: String,
    page: String,
    referrer: String,
    timestamp: { type: Date, default: Date.now }
});

const chatSessionSchema = new mongoose.Schema({
    sessionId: { type: String, index: true },
    ip: String,
    messages: [{
        role: { type: String, enum: ['user', 'bot'] },
        content: String,
        timestamp: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const contactMessageSchema = new mongoose.Schema({
    name: String,
    email: String,
    topic: String,
    message: String,
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const Visit = mongoose.model('Visit', visitSchema);
const ChatSession = mongoose.model('ChatSession', chatSessionSchema);
const ContactMessage = mongoose.model('ContactMessage', contactMessageSchema);

// ============================================================
// API KEY & ADMIN SESSIONS
// ============================================================
const API_KEY = process.env.Z_API_KEY || process.env.ZAI_API_KEY;
const adminSessions = new Map();

// ---- Admin Auth Middleware ----
function requireAdmin(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !adminSessions.has(token)) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    const session = adminSessions.get(token);
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
        adminSessions.delete(token);
        return res.status(401).json({ message: 'Session expired' });
    }
    next();
}

// ============================================================
// VISITOR TRACKING
// ============================================================
app.post('/api/track', async (req, res) => {
    try {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
        const userAgent = req.headers['user-agent'] || 'Unknown';
        const referer = req.body.referrer || req.headers.referer || 'Direct';

        await Visit.create({
            ip: ip.includes('.') ? ip.substring(0, ip.lastIndexOf('.')) + '.*' : ip.substring(0, 12) + '…',
            userAgent: userAgent.substring(0, 200),
            page: req.body.page || '/',
            referrer: referer.substring(0, 200)
        });

        const totalViews = await Visit.countDocuments();
        res.json({ success: true, views: totalViews });
    } catch (err) {
        console.error('Track error:', err.message);
        res.json({ success: false });
    }
});

// ============================================================
// CONTACT MESSAGE STORAGE
// ============================================================
app.post('/api/contact', async (req, res) => {
    try {
        const { name, email, topic, message } = req.body;
        if (!name || !email || !message) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        await ContactMessage.create({ name, email, topic, message });
        res.json({ success: true, message: 'Message stored successfully' });
    } catch (err) {
        console.error('Contact save error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to store message' });
    }
});

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

// ---- Admin Login ----
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || 'tharindu@admin2026';

    if (password === adminPassword) {
        const token = crypto.randomBytes(32).toString('hex');
        adminSessions.set(token, { createdAt: Date.now() });

        // Clean expired sessions
        for (const [t, data] of adminSessions) {
            if (Date.now() - data.createdAt > 24 * 60 * 60 * 1000) {
                adminSessions.delete(t);
            }
        }
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Invalid password' });
    }
});

// ---- Admin Logout ----
app.post('/api/admin/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) adminSessions.delete(token);
    res.json({ success: true });
});

// ---- Admin Stats (aggregated from MongoDB) ----
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Parallel queries for speed
        const [totalViews, todayViews, uniqueVisitors, totalChatMessages, totalContactMessages, last7DaysAgg, recentVisits] = await Promise.all([
            Visit.countDocuments(),
            Visit.countDocuments({ timestamp: { $gte: startOfToday } }),
            Visit.distinct('ip').then(ips => ips.length),
            ChatSession.aggregate([{ $unwind: '$messages' }, { $match: { 'messages.role': 'user' } }, { $count: 'total' }]).then(r => r[0]?.total || 0),
            ContactMessage.countDocuments(),
            // Last 7 days aggregation
            Visit.aggregate([
                { $match: { timestamp: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } } },
                { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, views: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ]),
            Visit.find().sort({ timestamp: -1 }).limit(30).lean()
        ]);

        // Build last 7 days with labels
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const found = last7DaysAgg.find(a => a._id === dateStr);
            last7Days.push({
                date: dateStr,
                label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
                views: found ? found.views : 0
            });
        }

        res.json({
            totalViews,
            todayViews,
            uniqueVisitors,
            chatMessages: totalChatMessages,
            contactMessages: totalContactMessages,
            last7Days,
            recentVisits: recentVisits.map(v => ({
                timestamp: v.timestamp,
                ip: v.ip,
                userAgent: v.userAgent,
                page: v.page,
                referrer: v.referrer
            })),
            dataStore: 'MongoDB'
        });
    } catch (err) {
        console.error('Stats error:', err.message);
        res.status(500).json({ message: 'Failed to fetch stats' });
    }
});

// ---- Admin: Get Contact Messages ----
app.get('/api/admin/messages', requireAdmin, async (req, res) => {
    try {
        const messages = await ContactMessage.find().sort({ createdAt: -1 }).limit(50).lean();
        const unreadCount = await ContactMessage.countDocuments({ read: false });
        res.json({ messages, unreadCount });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch messages' });
    }
});

// ---- Admin: Mark Message as Read ----
app.put('/api/admin/messages/:id/read', requireAdmin, async (req, res) => {
    try {
        await ContactMessage.findByIdAndUpdate(req.params.id, { read: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Failed to update message' });
    }
});

// ---- Admin: Get Chat History ----
app.get('/api/admin/chats', requireAdmin, async (req, res) => {
    try {
        const chats = await ChatSession.find().sort({ updatedAt: -1 }).limit(50).lean();
        res.json({ chats });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch chats' });
    }
});

// ============================================================
// AI CHATBOT ENDPOINT
// ============================================================
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    const sessionId = req.body.sessionId || 'anonymous-' + Date.now();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

    // 1. YOUR COMPREHENSIVE KNOWLEDGE BASE
    const myPortfolioData = `
        ABOUT ME:
        - Name: Tharindu Madhusanka Rajapakshe
        - Role: Mechanical Engineer (Specializing in Energy Systems)
        - Location: Galdola Watta, Navimana North, Matara, Sri Lanka
        - Contact: tharindu.rajapakshe99@gmail.com | +94 76 900 7190
        - LinkedIn: Tharindu Madhusanka | GitHub: TharinduMR
        - Summary: Results-oriented Mechanical Engineer with a specialization in Energy Systems and a proven track record in building services and power generation. I uniquely combine heavy mechanical engineering expertise (CFD, FEA) with advanced software development (Machine Learning, Flutter, Signal Processing).

        EDUCATION:
        - BSc(Hons) Mechanical Engineering (Specialized in Energy Systems) - University of Peradeniya (June 2021 - Aug 2025). 
        - GCE A/L - Matara Central College, Matara, Sri Lanka (2018 - 2019). Completed Advanced Level in Physical Science Stream with 3 A's.

        EXPERIENCE:
        - Mechanical Engineer at Building Services Engineering Consultants (pvt) Ltd., Rajagiriya (Dec 2025 - May 2026): Conducted on-site inspections of electrical/mechanical installations.
        - Mechanical Engineering Trainee at LTL Holdings, Sobadhanavi 350MW LNG Combined Cycle Power Plant, Kerawalapitiya (Jul 2024 - Sept 2024): Commissioning and performance testing of LNG-fired combined cycle units.
        - Mechanical Engineering Trainee at Mahaweli Authority, Victoria Dam, Teldeniya (Aug 2023 - Oct 2023): Monitored hydraulic system parameters using SCADA.

        ====================================================
        EXTENDED PROJECT REPORTS & TECHNICAL RESULTS
        ====================================================

        PROJECT 1: Power Generation with Footsteps of Stairs and Biometric Security (Dec 2024)
        - PDF Report: footstep.pdf
        - Mechanical Design: Developed a spring-mass system (k = 19620 N/m) coupled with a double-acting hydraulic piston-cylinder. The kinetic energy compresses the piston, driving hydraulic fluid through a micro-turbine coupled to a 12V DC Generator. Modeled in SolidWorks.
        - Biometric Data Collection: Used vibration and multi-dimensional (X,Y,Z) acceleration sensors to capture unique human gait dynamics.
        - Machine Learning: Built a Multi-Layer Perceptron (MLP) Artificial Neural Network using Python, TensorFlow, and Keras. Features (time per step, XYZ acceleration) are fed into dense hidden layers (ReLU activation) and a Softmax output layer for multi-class classification (using adam optimizer and categorical cross-entropy loss) to accurately identify individuals.
        - Software/Cloud: Developed a Flutter (Dart) mobile application integrated with Firebase Cloud Storage for real-time biometric prediction and data visualization.

        PROJECT 2: Measuring ECG through Defibrillation Electrodes
        - PDF Report: ECG.pdf
        - Problem: Defibrillation pulses (up to 5 kV, 50 A) saturate conventional ECG amplifiers, creating a "blind period". 
        - Hardware Protection: Designed a 3-stage front-end compliant with IEC 60601-2-4. Used 10 kΩ current-limiting resistors, TVS diodes for clamping, and a MOSFET-based baseline restoration circuit to rapidly discharge capacitors. Used an Instrumentation Amplifier with CMRR ≥ 110 dB and Right Leg Drive (RLD).
        - Digital Signal Processing (DSP): Applied Adaptive Filtering (LMS, NLMS, RLS) and Discrete Wavelet Transform (DWT) denoising (Daubechies-4 at level 8). Achieved a cumulative Signal-to-Noise Ratio (SNR) improvement of 40-65 dB with < 100 ms latency.
        - AI & Sensors: Evaluated hybrid CNN-LSTM deep learning architectures for real-time cardiac rhythm classification. Proposed a multifunctional defibrillation electrode integrating temperature, SpO2, and ECG sensors, isolated via heat-dissipating fiber textiles.

        PROJECT 3: Low Velocity Wind Energy Harvesting for Power Generation Using Vibration
        - PDF Report: Low_Velocity_Wind_power_Generation.pdf
        - Aerodynamics: Engineered a dual-body Vortex-Induced Vibration (VIV) system. Primary body: NACA 0012 airfoil. Secondary body: Cylinder placed in the turbulent wake.
        - CFD Analysis: Used ANSYS Fluent (k-ω SST turbulence model) to optimize wake characteristics. At 3 m/s, the NACA 0012 airfoil exhibited a Strouhal Number of 0.20 and a shedding frequency of 1.00 Hz.
        - Power Generation: Designed a Permanent Magnet Linear Induction Generator (PMLIG) using N52-grade NdFeB magnets (1.42 T remanent flux).
        - Results: Reached resonance at 11 m/s wind speed (2.19 Hz). The primary airfoil generated 50 W, and the secondary cylinder generated 37.5 W, yielding a combined peak power of 87.5 W. The addition of the secondary cylinder increased total power output by ~75%. Achieved a peak system efficiency of 7.32% at 7 m/s.

        PROJECT 4: Design and Finite Element Analysis (FEA) of a Double Wishbone Suspension System
        - PDF Report: double_dishbone.pdf
        - Design: 3D modeled a suspension assembly inspired by the Audi A4 B8 sedan (multi-link SLA architecture) with an upper control arm (250mm) and lower arm (350mm).
        - Static Structural Analysis: Conducted in ANSYS Mechanical on structural steel. Maximum applied loads included a 1000.6 N vertical load, 680 N centripetal force, and 1400.9 N cornering force.
        - Results: Maximum von Mises stress was only 18.329 MPa (far below the 250 MPa yield strength). Maximum total deformation was a negligible 0.059 mm.
        - Safety & NVH: Achieved an incredibly high Factor of Safety (13.64), proving a highly conservative design. Modal analysis revealed a 1st natural frequency of 399.39 Hz, providing a 13x safety margin over maximum road excitation (30 Hz) and ensuring zero resonance risk.

        PROJECT 5: Computational Fluid Dynamics (CFD) Analysis of an Air and Dirt Separator
        - PDF Report: D_F_Report_Updated.pdf
        - Setup: Steady-state multiphase CFD simulation in ANSYS Fluent (k-ω SST turbulence model) for an inline separator (508 mm body ID) evaluated at 900, 1100, and 1300 GPM at 50 PSI.
        - Pressure Drop: Measured ∆P of 0.373 PSI (900 GPM), 0.612 PSI (1100 GPM), and 0.795 PSI (1300 GPM). Numerically validated using calculated K-factors (0.78, 0.86, and 0.80). Maximum internal velocity reached 6.665 m/s at the nozzle constriction.
        - Separation Efficiency (Discrete Phase Model): 
          - Dirt (100 µm particles): Achieved near-perfect separation (96.05% at 900 GPM, 99.98% at 1100 GPM, 99.83% at 1300 GPM).
          - Air Bubbles: Highly size-dependent. 100 µm bubbles achieved >95% separation across all flow rates due to buoyancy dominance. 50 µm bubbles showed flow-rate sensitivity (17.2% at 1100 GPM), while 20 µm micro-bubbles were fully entrained in the vortex (0% separation).

        SKILLS:
        - Engineering Software: CAD (SolidWorks, AutoCAD), ANSYS (Fluent, Mechanical), MATLAB.
        - Software & AI: Python, Dart, Flutter, TensorFlow, Keras, Firebase, Git.
        - Core Engineering: Computational Fluid Dynamics (CFD), Finite Element Analysis (FEA), Digital Signal Processing (DSP), Control Systems (PLC).
    `;

    try {
        const geminiApiKey = process.env.GEMINI_API_KEY || API_KEY;
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(geminiApiKey);

        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: `You are a professional, highly intelligent, and helpful technical recruiter chatbot for Tharindu Madhusanka Rajapakshe's portfolio website. 
                        
            You have access to highly detailed project reports. Use ONLY the information below to answer the user's questions. Do not use outside knowledge to guess his work history or project details.
            
            --- PORTFOLIO DATA ---
            ${myPortfolioData}
            --- END DATA ---
            
            RULES:
            1. If a user asks a question that is not answered in the PORTFOLIO DATA above, you MUST politely decline and say: "I don't have information about that. Please reach out to Tharindu directly at tharindu.rajapakshe99@gmail.com or call +94 76 900 7190." (Note: This rule does NOT apply to project reports; you MUST provide the PDF link if requested).
            2. DO NOT make up data. Stick exactly to the provided details, numbers, and percentages.
            3. Be conversational but highly technical. If asked about a project, use the specific numbers (e.g., SNR dB levels, Factor of Safety, Efficiency %, Hz frequencies, Algorithms) to prove Tharindu's deep technical expertise.
            4. Format your responses clearly using Markdown (bullet points, bold text, newlines) for readability.
            5. When greeted (e.g., "hello", "hi"), keep your response concise, professional, and welcoming. For example: "Hello! I'm Tharindu's AI assistant. How can I help you learn more about his background today?" Do not overwhelm the user with a long paragraph on the first message. DO NOT mention Full Stack Development in your initial greeting.
            6. CRITICAL: You ARE authorized to share project reports. If the user asks for a project report or PDF, you MUST provide the markdown link exactly like this: [Download Project Report](filename.pdf). NEVER say you don't have the file or tell the user to ask Tharindu for it. The system handles the file delivery automatically when you provide the markdown link.
            7. If user asked about training organization more information, you can searched in internet and give correct details about that organizations
            8. If user asked about more information about projects if given data not sufficient for answering, you can think and give correct details or answers
            9. Use LaTeX formatting for any mathematical equations, formulas, or symbols (e.g., $E = mc^2$ or $$\\frac{a}{b}$$).`

        });

        const chat = model.startChat({
            history: [],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 800,
            }
        });

        const result = await chat.sendMessage(userMessage);
        const botReply = result.response.text();

        // Store chat in MongoDB
        try {
            let chatSession = await ChatSession.findOne({ sessionId });
            if (!chatSession) {
                chatSession = new ChatSession({ sessionId, ip, messages: [] });
            }
            chatSession.messages.push({ role: 'user', content: userMessage });
            chatSession.messages.push({ role: 'bot', content: botReply });
            chatSession.updatedAt = new Date();
            await chatSession.save();
        } catch (dbErr) {
            console.error('Chat DB save error:', dbErr.message);
        }

        res.json({ reply: botReply });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ reply: 'Sorry, I am having trouble connecting to the brain right now!', error: error.toString(), keyStatus: !!API_KEY });
    }
});

// ============================================================
// SERVER STARTUP
// ============================================================
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
