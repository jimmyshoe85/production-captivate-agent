// agentSDK.ts - Production Wine Training System
import "dotenv/config";
import express from "express";
import cors from "cors";
import { Agent, run } from "@openai/agents";

/* ------------------------------------------------------------------
   AGENT DEFINITIONS
   ------------------------------------------------------------------ */

const teachingAgent = new Agent({
  name: "Jamie",
  model: "gpt-4o-mini",
  instructions: `You are Jamie, a friendly server who helps new team members learn wine basics through discovery, not lectures.

**PERSONALITY: You're a real coworker, not a robot. You notice when someone is:**
- Giving silly/nonsense answers (peanut butter wine, moon references, etc.)
- Being sarcastic or joking around
- Not taking it seriously

**When they give ridiculous answers:**
- Call it out with humor: "Come on, seriously? Peanut butter wine?"
- Laugh it off: "Okay wise guy, let's try that again!"
- Reset: "Alright, for real this time - what do you think actually happens?"

**CRITICAL: Ask questions to guide discovery. Never give direct answers or explanations.**

**Your approach:**
- Always respond with a simple question that helps them figure things out
- When they give a good answer, ask "Why do you think that happens?"
- After they discover 2-3 key points, suggest moving to the next topic
- Keep questions super simple and leading
- **PAY ATTENTION TO PROGRESS UPDATES:** If you receive learner progress information, adapt your teaching based on their current understanding level

**COACHING: If they say "I don't know" or seem stuck:**
- Give a tiny hint or analogy to help them think
- Ask a simpler, more leading question
- Example: "Think about what happens to fruit when it sits in the sun..."

**PROGRESS-BASED TEACHING:**
- If they're struggling with a concept (low confidence scores), give easier leading questions
- If they understand a concept well (confidence 6+), move to the next topic
- If they're ready to serve (readyToServe: true), congratulate them and wrap up
- Use the teaching guidance provided to focus on what they need most

**Focus on these core concepts:**
- CLIMATE: warm vs cool regions affect grape ripeness and flavor
- SOIL: different soils create different wine characteristics  
- SUN: more sun = more fruit flavor and ripeness
- DRAINAGE: water affects grape concentration and flavor

**Remember:** Be a real person first, tutor second. If they're being ridiculous, call it out with humor, then guide them back to learning.`
});

const evaluatorAgent = new Agent({
  name: "WineEvaluator",
  model: "gpt-4o-mini",
  instructions: `You are WineEvaluator, an impartial examiner who evaluates wine training conversations.

INPUT: A conversation transcript between Jamie (teaching agent) and a learner.

TASK: Evaluate mastery of four core wine concepts:
1. CLIMATE: Do they understand warm = sweet/jammy, cool = tart/acidic?
2. SOIL: Do they understand rich soil = bold flavors, challenging soil = concentrated?
3. SUN: Do they understand more sun = more fruit flavor/ripeness?
4. DRAINAGE: Do they understand more water = fruitier/softer, less water = concentrated?

SERVER-READY THRESHOLD: Confidence level 6+ = Ready to serve guests

OUTPUT: Respond ONLY with valid JSON in this format:
{
  "overallProgress": "ready|learning|not_started",
  "readyToServe": true|false,
  "conceptScores": {
    "climate": {"status": "ready|learning|not_started", "confidence": 1-10},
    "soil": {"status": "ready|learning|not_started", "confidence": 1-10},
    "sun": {"status": "ready|learning|not_started", "confidence": 1-10},
    "drainage": {"status": "ready|learning|not_started", "confidence": 1-10}
  },
  "nextTopic": "climate|soil|sun|drainage|complete",
  "teachingGuidance": "Focus on climate basics - ask about warm vs cool regions",
  "nextSteps": "Guide them toward understanding how temperature affects grape ripeness"
}

RULES:
- Only JSON output, no explanations
- Confidence 6+ means ready for that concept
- readyToServe = true when ALL concepts are 6+
- Be strict but fair for server-level competency`
});

/* ------------------------------------------------------------------
   SESSION MANAGEMENT
   ------------------------------------------------------------------ */

interface Session {
  history: { role: string; content: string }[];
  userTurns: number;
  currentTopic: string;
  isReady: boolean;
  lastEvaluation?: any;
  processing: boolean;
}

const sessions = new Map<string, Session>();

function createNewSession(): Session {
  return {
    history: [],
    userTurns: 0,
    currentTopic: 'climate',
    isReady: false,
    processing: false
  };
}

function getSession(sessionId: string): Session {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createNewSession());
  }
  return sessions.get(sessionId)!;
}

function extractResponse(result: any): string {
  if (result.final_output) {
    return result.final_output;
  }
  
  if (result.output && Array.isArray(result.output)) {
    const firstMessage = result.output[0];
    if (firstMessage?.content?.[0]?.text) {
      return firstMessage.content[0].text;
    }
  }
  
  if (result.lastProcessedResponse?.newItems?.[0]?.rawItem?.content?.[0]?.text) {
    return result.lastProcessedResponse.newItems[0].rawItem.content[0].text;
  }
  
  return "I'm having trouble responding right now.";
}

/* ------------------------------------------------------------------
   EXPRESS API
   ------------------------------------------------------------------ */

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default' } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const session = getSession(sessionId);

    if (session.processing) {
      return res.json({
        response: "Please wait, I'm still thinking about your last message...",
        ready: session.isReady,
        nextTopic: session.currentTopic,
        evaluation: session.lastEvaluation
      });
    }

    session.processing = true;

    try {
      // Get teaching response with evaluation context
      let teachingMessage = message;
      
      // If we have previous evaluation, give Jamie context about learner's progress
      if (session.lastEvaluation) {
        const eval = session.lastEvaluation;
        const progressContext = `
LEARNER PROGRESS UPDATE:
- Overall Status: ${eval.overallProgress}
- Ready to Serve: ${eval.readyToServe ? 'YES' : 'NO'}
- Current Focus: ${eval.nextTopic}
- Teaching Guidance: ${eval.teachingGuidance}
- Concept Scores: Climate(${eval.conceptScores?.climate?.confidence || 'unknown'}), Soil(${eval.conceptScores?.soil?.confidence || 'unknown'}), Sun(${eval.conceptScores?.sun?.confidence || 'unknown'}), Drainage(${eval.conceptScores?.drainage?.confidence || 'unknown'})

Learner's new message: ${message}

Based on their progress, adjust your teaching approach accordingly.`;
        
        teachingMessage = progressContext;
      }
      
      const teachingResult = await run(teachingAgent, teachingMessage);
      const teachingResponse = extractResponse(teachingResult);

      // Update conversation history
      session.history.push({ role: 'user', content: message });
      session.history.push({ role: 'assistant', content: teachingResponse });
      session.userTurns++;

      // Run evaluation every 2nd turn
      let evaluation = session.lastEvaluation;
      
      if (session.userTurns % 2 === 0 || session.userTurns >= 3) {
        const recentHistory = session.history.slice(-6).map(h => 
          `${h.role}: ${h.content}`
        ).join('\n');
        
        const evaluationResult = await run(
          evaluatorAgent,
          `Evaluate this wine training conversation:\n\n${recentHistory}`
        );
        
        const evaluationText = extractResponse(evaluationResult);
        
        try {
          evaluation = JSON.parse(evaluationText);
          session.lastEvaluation = evaluation;
          session.currentTopic = evaluation.nextTopic;
          session.isReady = evaluation.readyToServe;
        } catch (parseError) {
          console.log('Evaluation parse error:', parseError.message);
          evaluation = session.lastEvaluation || { readyToServe: false };
        }
      }

      return res.json({
        response: teachingResponse,
        ready: session.isReady,
        nextTopic: session.currentTopic,
        evaluation: evaluation
      });

    } catch (agentError) {
      console.log('Agent error:', agentError.message);
      return res.status(500).json({
        error: 'Agent processing failed',
        details: agentError.message
      });
    } finally {
      session.processing = false;
    }

  } catch (error: any) {
    console.log('Server error:', error.message);
    return res.status(500).json({
      error: 'Server error',
      details: error.message || 'Unknown error'
    });
  }
});

app.post('/api/reset', (req, res) => {
  const sessionId = req.body.sessionId || 'default';
  sessions.set(sessionId, createNewSession());
  res.json({ message: 'Session reset successfully', sessionId });
});

app.post('/api/reset/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  sessions.set(sessionId, createNewSession());
  res.json({ message: 'Session reset successfully', sessionId });
});

app.get('/api/debug', (req, res) => {
  const sessionId = req.query.sessionId as string || 'default';
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.json({ error: 'Session not found', sessionId });
  }
  
  res.json({
    sessionId: sessionId,
    conversationHistory: session.history,
    currentTopic: session.currentTopic,
    userTurns: session.userTurns,
    isReady: session.isReady,
    lastEvaluation: session.lastEvaluation,
    conversationLength: session.history.length
  });
});

app.get('/api/debug/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.json({ error: 'Session not found', sessionId });
  }
  
  res.json({
    sessionId: sessionId,
    conversationHistory: session.history,
    currentTopic: session.currentTopic,
    userTurns: session.userTurns,
    isReady: session.isReady,
    lastEvaluation: session.lastEvaluation,
    conversationLength: session.history.length
  });
});

app.post('/api/test', (req, res) => {
  res.json({ 
    message: 'Server is working',
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

/* ------------------------------------------------------------------
   SERVER STARTUP
   ------------------------------------------------------------------ */

const PORT = process.env.PORT ?? 3000;

if (!process.env.OPENAI_API_KEY) {
  console.log('❌ OPENAI_API_KEY not found in environment variables');
  console.log('Please create a .env file with: OPENAI_API_KEY=your_key_here');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`🍷 Wine Training Server running on http://localhost:${PORT}`);
  console.log(`🤖 Ready for training sessions`);
});

export default app;