
// index.js - SoloPay Backend for PDF Statement Analyzer
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import pdf from 'pdf-parse-new';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3001;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware - Simple CORS allowing all origins
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for text data

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  }
});

// Create temp directory on startup
const tempDir = path.join(__dirname, 'temp');
fs.mkdir(tempDir, { recursive: true }).catch(console.error);

// =====================================================
// NEW ENDPOINT: Analyze extracted text (no PDF processing needed)
// =====================================================
app.post('/api/analyze-text', async (req, res) => {
  console.log('Analyzing text from client - Type:', req.body.documentType);
  
  try {
    const { text, documentType } = req.body;

    if (!text) {
      return res.status(400).json({ 
        error: 'No text provided for analysis' 
      });
    }

    // Process with OpenAI directly (no PDF extraction needed)
    console.log('Processing with OpenAI...');
    console.log('Text length received:', text.length);
    
    const prompt = documentType === 'bank' 
      ? getBankStatementPrompt(text)
      : getCreditCardPrompt(text);

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini", // Using the cost-effective model that handles large inputs well
        messages: [
          { 
            role: "system", 
            content: "You are an expert financial analyst. Your response must be only a single, valid JSON object and nothing else. Do not include any markdown, explanations, or additional text." 
          },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }, // Forces valid JSON output
        temperature: 0.1,
        max_tokens: 8192
      });

      const analysisText = completion.choices[0].message.content;
      console.log('OpenAI response received, length:', analysisText.length);
      
      // Parse the guaranteed JSON response
      const analysis = JSON.parse(analysisText);
      
      res.json({
        status: 'success',
        analysis: analysis,
        documentType: documentType,
        textLength: text.length
      });
      
    } catch (openaiError) {
      console.error('OpenAI API error:', openaiError);
      
      // Fallback structure if OpenAI fails
      res.json({
        status: 'partial',
        analysis: {
          summary: {
            totalDeposits: 0,
            totalWithdrawals: 0,
            netFlow: 0,
            error: 'Analysis failed - ' + openaiError.message
          },
          categories: {},
          alerts: ['Analysis could not be completed'],
        },
        documentType: documentType,
        textLength: text.length
      });
    }

  } catch (error) {
    console.error('Error analyzing text:', error);
    res.status(500).json({
      error: 'Failed to analyze document',
      details: error.message
    });
  }
});

// =====================================================
// STEP 1A: Check if PDF is password protected (Firebase URL)
// =====================================================
app.post('/api/check-pdf-url', async (req, res) => {
  console.log('Checking PDF from Firebase URL');
  
  try {
    const { pdfUrl, fileName, fileSize } = req.body;
    
    if (!pdfUrl) {
      return res.status(400).json({ error: 'No PDF URL provided' });
    }

    // Download PDF from Firebase URL
    console.log('Downloading from Firebase:', pdfUrl);
    const response = await fetch(pdfUrl);
    
    if (!response.ok) {
      throw new Error('Failed to download PDF from Firebase');
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuffer);
    
    // Try to load the PDF without password
    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      
      // If successful, PDF is not password protected
      const sessionId = generateSessionId();
      await saveTemporaryFile(sessionId, pdfBuffer);
      
      res.json({
        status: 'success',
        passwordRequired: false,
        message: 'No password required. Click to continue.',
        fileName: fileName,
        fileSize: fileSize,
        sessionId: sessionId
      });
      
    } catch (error) {
      if (error.message && error.message.includes('encrypted')) {
        // PDF is password protected
        const sessionId = generateSessionId();
        await saveTemporaryFile(sessionId, pdfBuffer);
        
        res.json({
          status: 'password_required',
          passwordRequired: true,
          message: 'This PDF is password protected. Please enter the password.',
          fileName: fileName,
          fileSize: fileSize,
          sessionId: sessionId
        });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error checking PDF from URL:', error);
    res.status(500).json({
      error: 'Failed to check PDF',
      details: error.message
    });
  }
});

// =====================================================
// STEP 1B: Original Check PDF endpoint (for compatibility)
// =====================================================
app.post('/api/check-pdf', upload.single('pdf'), async (req, res) => {
  console.log('Checking PDF - File received:', req.file?.originalname);
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const pdfBuffer = req.file.buffer;
    
    // Try to load the PDF without password
    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      
      // If successful, PDF is not password protected
      const sessionId = generateSessionId();
      await saveTemporaryFile(sessionId, pdfBuffer);
      
      res.json({
        status: 'success',
        passwordRequired: false,
        message: 'No password required. Click to continue.',
        fileName: req.file.originalname,
        fileSize: req.file.size,
        sessionId: sessionId
      });
      
    } catch (error) {
      if (error.message && error.message.includes('encrypted')) {
        // PDF is password protected
        const sessionId = generateSessionId();
        await saveTemporaryFile(sessionId, pdfBuffer);
        
        res.json({
          status: 'password_required',
          passwordRequired: true,
          message: 'This PDF is password protected. Please enter the password.',
          fileName: req.file.originalname,
          fileSize: req.file.size,
          sessionId: sessionId
        });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error checking PDF:', error);
    res.status(500).json({
      error: 'Failed to check PDF',
      details: error.message
    });
  }
});

// =====================================================
// STEP 2: Unlock password-protected PDF
// =====================================================
app.post('/api/unlock-pdf', async (req, res) => {
  console.log('Unlocking PDF - Session:', req.body.sessionId);
  
  try {
    const { sessionId, password } = req.body;

    if (!sessionId || !password) {
      return res.status(400).json({ 
        error: 'Session ID and password are required' 
      });
    }

    // Retrieve temporary file
    const pdfBuffer = await getTemporaryFile(sessionId);
    
    if (!pdfBuffer) {
      return res.status(404).json({ 
        error: 'Session expired or file not found' 
      });
    }

    // Try to unlock with provided password
    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer, { password });
      
      // Save unlocked version
      const unlockedPdfBytes = await pdfDoc.save();
      await saveTemporaryFile(`${sessionId}_unlocked`, Buffer.from(unlockedPdfBytes));

      res.json({
        status: 'success',
        message: 'PDF unlocked successfully! Processing...',
        sessionId: `${sessionId}_unlocked`
      });

    } catch (error) {
      if (error.message && error.message.includes('password')) {
        res.status(401).json({
          status: 'invalid_password',
          error: 'Incorrect password. Please try again.'
        });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error unlocking PDF:', error);
    res.status(500).json({
      error: 'Failed to unlock PDF',
      details: error.message
    });
  }
});

// =====================================================
// STEP 3: Process PDF and Extract Data
// =====================================================
app.post('/api/process-pdf', async (req, res) => {
  console.log('Processing PDF - Session:', req.body.sessionId, 'Type:', req.body.type);
  
  try {
    const { sessionId, type } = req.body; // type: 'bank' or 'credit'

    const pdfBuffer = await getTemporaryFile(sessionId);
    
    if (!pdfBuffer) {
      return res.status(404).json({ 
        error: 'Session expired or file not found' 
      });
    }

    // Extract text from PDF
    console.log('Extracting text from PDF...');
    const pdfData = await pdf(pdfBuffer);
    const extractedText = pdfData.text;
    console.log('Text extracted, length:', extractedText.length);

    // Clean up temporary file
    await deleteTemporaryFile(sessionId);

    // Process with OpenAI
    console.log('Processing with OpenAI...');
    
    const prompt = type === 'bank' 
      ? getBankStatementPrompt(extractedText)
      : getCreditCardPrompt(extractedText);

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini", // Using the cost-effective model that handles large inputs well
        messages: [
          { 
            role: "system", 
            content: "You are an expert financial analyst. Your response must be only a single, valid JSON object and nothing else. Do not include any markdown, explanations, or additional text." 
          },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }, // Forces valid JSON output
        temperature: 0.1,
        max_tokens: 8192
      });

      const analysisText = completion.choices[0].message.content;
      console.log('OpenAI response received, length:', analysisText.length);
      
      // Parse the guaranteed JSON response
      const analysis = JSON.parse(analysisText);
      
      res.json({
        status: 'success',
        analysis: analysis,
        documentType: type,
        textLength: extractedText.length
      });
      
    } catch (openaiError) {
      console.error('OpenAI API error:', openaiError);
      
      // Fallback structure if OpenAI fails
      res.json({
        status: 'partial',
        analysis: {
          summary: {
            error: 'Analysis failed - ' + openaiError.message
          },
          rawResponse: 'OpenAI processing failed'
        },
        documentType: type,
        textLength: extractedText.length
      });
    }

  } catch (error) {
    console.error('Error processing PDF:', error);
    res.status(500).json({
      error: 'Failed to process PDF',
      details: error.message
    });
  }
});

// =====================================================
// STEP 4: Generate and Download Excel Report (No Email)
// =====================================================
app.post('/api/generate-report', async (req, res) => {
  console.log('Generating Excel report for download');
  
  try {
    const { analysis, documentType } = req.body;

    if (!analysis) {
      return res.status(400).json({
        error: 'Analysis data is required'
      });
    }

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    
    if (documentType === 'bank') {
      createBankStatementExcel(workbook, analysis);
    } else {
      createCreditCardExcel(workbook, analysis);
    }

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();

    // Send Excel file as download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=statement_analysis_${Date.now()}.xlsx`);
    res.send(buffer);

  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({
      error: 'Failed to generate report',
      details: error.message
    });
  }
});

// =====================================================
// Settings endpoint to save email
// =====================================================
app.post('/api/settings', async (req, res) => {
  const { email } = req.body;
  // In production, save this to database
  console.log('Email saved:', email);
  res.json({ status: 'success', message: 'Settings saved' });
});

// =====================================================
// Helper Functions
// =====================================================

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function saveTemporaryFile(sessionId, buffer) {
  const tempDir = path.join(__dirname, 'temp');
  await fs.mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${sessionId}.pdf`);
  await fs.writeFile(filePath, buffer);
  console.log('File saved temporarily:', sessionId);
}

async function getTemporaryFile(sessionId) {
  try {
    const filePath = path.join(__dirname, 'temp', `${sessionId}.pdf`);
    return await fs.readFile(filePath);
  } catch (error) {
    console.error('File not found:', sessionId);
    return null;
  }
}

async function deleteTemporaryFile(sessionId) {
  try {
    const filePath = path.join(__dirname, 'temp', `${sessionId}.pdf`);
    await fs.unlink(filePath);
    console.log('Temp file deleted:', sessionId);
  } catch (error) {
    console.error('Error deleting temp file:', error);
  }
}

function getBankStatementPrompt(text) {
  // For large texts, take strategic portions
  let textToAnalyze = text;
  if (text.length > 100000) {
    const first = text.substring(0, 30000);
    const last = text.substring(text.length - 30000);
    textToAnalyze = first + '\n...[MIDDLE SECTION OMITTED FOR LENGTH]...\n' + last;
    console.log(`Text trimmed from ${text.length} to ${textToAnalyze.length} characters`);
  }

  return `
    Analyze this bank statement and extract ALL information.
    
    Extract the following from the bank statement:
    1. Account information (bank name, account number, period)
    2. Opening and closing balances - MUST be accurate numbers
    3. Total deposits and withdrawals - MUST sum all transactions accurately
    4. Transaction categorization (UPI, NEFT, ATM, etc.)
    5. Top 5 highest transactions
    6. Monthly spending patterns if multi-month
    7. For large statements (>100 transactions), include summary only, not all transactions
    
    CRITICAL: All balance and transaction amounts must be accurate. Double-check calculations.
    
    Return this EXACT JSON structure:
    {
      "accountInfo": {
        "bankName": "string",
        "accountNumber": "string",
        "period": "string",
        "openingBalance": number,
        "closingBalance": number
      },
      "summary": {
        "totalDeposits": number,
        "totalWithdrawals": number,
        "netFlow": number,
        "transactionCount": number,
        "avgDailySpending": number
      },
      "categories": {
        "upi": { "total": number, "count": number, "percentage": number },
        "neft": { "total": number, "count": number, "percentage": number },
        "atm": { "total": number, "count": number, "percentage": number },
        "creditCard": { "total": number, "count": number, "percentage": number },
        "others": { "total": number, "count": number, "percentage": number }
      },
      "monthlyPatterns": {
        "highestSpendingMonth": "string",
        "lowestSpendingMonth": "string",
        "averageMonthlySpending": number
      },
      "recurringPayments": [
        { "description": "string", "amount": number, "frequency": "string" }
      ],
      "topTransactions": [
        { "date": "string", "description": "string", "amount": number, "type": "debit/credit" }
      ],
      "alerts": ["string"],
      "transactions": []
    }
    
    Bank Statement Text:
    ${textToAnalyze}
  `;
}

function getCreditCardPrompt(text) {
  // For large texts, take strategic portions
  let textToAnalyze = text;
  if (text.length > 100000) {
    const first = text.substring(0, 30000);
    const last = text.substring(text.length - 30000);
    textToAnalyze = first + '\n...[MIDDLE SECTION OMITTED FOR LENGTH]...\n' + last;
    console.log(`Text trimmed from ${text.length} to ${textToAnalyze.length} characters`);
  }

  return `
    Analyze this credit card statement and extract ALL information.
    
    Extract:
    1. All transactions with date, merchant, and amount
    2. Identify ALL subscriptions (Netflix, Spotify, ChatGPT, etc.)
    3. Categorize spending by type
    4. Find expensive transactions
    5. Calculate total spending - MUST be accurate
    
    Return this EXACT JSON structure:
    {
      "cardInfo": {
        "bankName": "string",
        "cardNumber": "string",
        "statementPeriod": "string",
        "creditLimit": number,
        "availableCredit": number
      },
      "summary": {
        "totalSpent": number,
        "paymentMade": number,
        "minimumDue": number,
        "dueDate": "string",
        "outstandingBalance": number
      },
      "subscriptions": [
        { 
          "merchant": "string", 
          "amount": number, 
          "category": "string",
          "frequency": "monthly/annual"
        }
      ],
      "categories": {
        "dining": { "total": number, "count": number, "percentage": number },
        "shopping": { "total": number, "count": number, "percentage": number },
        "travel": { "total": number, "count": number, "percentage": number },
        "entertainment": { "total": number, "count": number, "percentage": number },
        "utilities": { "total": number, "count": number, "percentage": number },
        "others": { "total": number, "count": number, "percentage": number }
      },
      "expensiveTransactions": [
        { "date": "string", "merchant": "string", "amount": number }
      ],
      "alerts": ["string"],
      "transactions": []
    }
    
    Credit Card Statement Text:
    ${textToAnalyze}
  `;
}

function createBankStatementExcel(workbook, analysis) {
  // Worksheet 1: Raw Data
  const rawSheet = workbook.addWorksheet('All Transactions');
  rawSheet.columns = [
    { header: 'Date', key: 'date', width: 15 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Debit', key: 'debit', width: 15 },
    { header: 'Credit', key: 'credit', width: 15 },
    { header: 'Balance', key: 'balance', width: 15 },
    { header: 'Category', key: 'category', width: 15 }
  ];

  // Add transactions
  if (analysis.transactions && Array.isArray(analysis.transactions)) {
    analysis.transactions.forEach(t => {
      rawSheet.addRow({
        date: t.date || '',
        description: t.description || '',
        debit: t.debit || 0,
        credit: t.credit || 0,
        balance: t.balance || 0,
        category: t.category || ''
      });
    });
  }

  // Worksheet 2: Summary
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 20 }
  ];

  // Add summary data
  if (analysis.summary) {
    summarySheet.addRow({ metric: 'Total Deposits', value: analysis.summary.totalDeposits || 0 });
    summarySheet.addRow({ metric: 'Total Withdrawals', value: analysis.summary.totalWithdrawals || 0 });
    summarySheet.addRow({ metric: 'Net Flow', value: analysis.summary.netFlow || 0 });
    summarySheet.addRow({ metric: 'Transaction Count', value: analysis.summary.transactionCount || 0 });
    summarySheet.addRow({ metric: 'Average Daily Spending', value: analysis.summary.avgDailySpending || 0 });
  }

  // Add category breakdown
  summarySheet.addRow({ metric: '', value: '' }); // Empty row
  summarySheet.addRow({ metric: 'Category Breakdown', value: '' });
  
  if (analysis.categories) {
    Object.entries(analysis.categories).forEach(([cat, data]) => {
      summarySheet.addRow({ 
        metric: cat.toUpperCase(), 
        value: `₹${data.total || 0} (${data.count || 0} transactions)` 
      });
    });
  }
}

function createCreditCardExcel(workbook, analysis) {
  // Worksheet 1: All Transactions
  const transSheet = workbook.addWorksheet('Transactions');
  transSheet.columns = [
    { header: 'Date', key: 'date', width: 15 },
    { header: 'Merchant', key: 'merchant', width: 35 },
    { header: 'Amount', key: 'amount', width: 15 },
    { header: 'Category', key: 'category', width: 20 }
  ];

  if (analysis.transactions && Array.isArray(analysis.transactions)) {
    analysis.transactions.forEach(t => {
      transSheet.addRow(t);
    });
  }

  // Worksheet 2: Subscriptions
  const subSheet = workbook.addWorksheet('Subscriptions');
  subSheet.columns = [
    { header: 'Service', key: 'merchant', width: 30 },
    { header: 'Amount', key: 'amount', width: 15 },
    { header: 'Frequency', key: 'frequency', width: 15 },
    { header: 'Category', key: 'category', width: 20 }
  ];

  if (analysis.subscriptions && Array.isArray(analysis.subscriptions)) {
    analysis.subscriptions.forEach(s => {
      subSheet.addRow(s);
    });
  }

  // Worksheet 3: Summary
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 20 }
  ];

  if (analysis.summary) {
    summarySheet.addRow({ metric: 'Total Spent', value: analysis.summary.totalSpent || 0 });
    summarySheet.addRow({ metric: 'Payment Made', value: analysis.summary.paymentMade || 0 });
    summarySheet.addRow({ metric: 'Outstanding Balance', value: analysis.summary.outstandingBalance || 0 });
  }
}

// Health check endpoint with all routes listed
app.get('/', (req, res) => {
  res.json({ 
    status: 'SoloPay Backend Running',
    endpoints: [
      'POST /api/check-pdf',
      'POST /api/check-pdf-url',
      'POST /api/unlock-pdf',
      'POST /api/process-pdf',
      'POST /api/analyze-text',
      'POST /api/generate-report'
    ],
    version: '3.0',
    features: ['OpenAI GPT-4o-mini', 'Client-side PDF processing', 'Firebase URL support', 'Direct Excel download']
  });
});

// Clean up temp files periodically (every hour)
setInterval(async () => {
  try {
    const tempDir = path.join(__dirname, 'temp');
    const files = await fs.readdir(tempDir).catch(() => []);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);
      const age = now - stats.mtimeMs;
      
      // Delete files older than 1 hour
      if (age > 3600000) {
        await fs.unlink(filePath);
        console.log(`Cleaned up old temp file: ${file}`);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 3600000); // Run every hour

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     🚀 SoloPay Backend Started!        ║
╠════════════════════════════════════════╣
║  Port: ${PORT}                            ║
║  Status: Ready                         ║
║  PDF Support: ✅                       ║
║  Password PDFs: ✅                     ║
║  OpenAI GPT-4o: ${process.env.OPENAI_API_KEY ? '✅' : '❌ Missing API Key'}                    ║
║  Excel Export: ✅                      ║
║  Firebase URLs: ✅                     ║
║  Text Analysis: ✅                     ║
╚════════════════════════════════════════════════════════════════╝
  `);
});