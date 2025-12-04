// server.js - Multi-Plate EVG Monitor Backend
// Install: npm install express puppeteer twilio node-cron dotenv body-parser

const express = require('express');
const puppeteer = require('puppeteer');
const twilio = require('twilio');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

// Twilio configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Storage for multiple plates (use database in production)
let monitoringState = {
  isActive: false,
  checkInterval: 15,
  plates: [
    // Example structure:
    // {
    //   id: 'unique-id',
    //   plateNumber: 'ABC1234',
    //   phoneNumber: '+971501234567',
    //   status: 'pending', // 'pending', 'checking', 'clear', 'found', 'error'
    //   lastChecked: null,
    //   alertSent: false
    // }
  ],
  lastCheckTime: null
};

// Function to check EVG page for a specific plate number
async function checkEVGForPlate(plateNumber) {
  let browser;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    
    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate to EVG page
    const evgUrl = 'https://evg.ae/_layouts/EVG/gettickets.aspx?language=en&action=bannertcf&key=CxdByg2XNuFSyUYBxNu4Ke759JexznrMypHZ04FijaEilAYneiXTfG4qzD6c4cnb';
    
    console.log(`Navigating to EVG for plate: ${plateNumber}`);
    
    await page.goto(evgUrl, { 
      waitUntil: 'networkidle2',
      timeout: 240000
    });

    // Wait for page to load
    await page.waitForTimeout(24000);

    // Get page content
    const content = await page.content();
    
    // Method 1: Simple text search
    const foundInText = content.toLowerCase().includes(plateNumber.toLowerCase());
    
    // Method 2: More specific - look for table rows or specific elements
    // Adjust selectors based on actual EVG page structure
    const plateElements = await page.evaluate(() => {
      // Try to find all text content that might contain plate numbers
      const elements = Array.from(document.querySelectorAll('td, div, span, p'));
      return elements.map(el => el.textContent.trim()).filter(text => text.length > 0);
    });
    
    const foundInElements = plateElements.some(text => 
      text.toUpperCase().includes(plateNumber.toUpperCase())
    );
    
    console.log(`Plate ${plateNumber}: Found in text=${foundInText}, Found in elements=${foundInElements}`);
    
    await browser.close();
    return foundInText || foundInElements;
    
  } catch (error) {
    console.error(`Error checking plate ${plateNumber}:`, error.message);
    if (browser) await browser.close();
    throw error;
  }
}

// Function to send SMS via Twilio
async function sendSMS(phoneNumber, plateNumber) {
  try {
    const message = await twilioClient.messages.create({
      body: `🚨 EVG ALERT: Traffic fine detected for vehicle ${plateNumber}. Please check https://evg.ae for details.`,
      from: TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });
    
    console.log(`✓ SMS sent to ${phoneNumber} for plate ${plateNumber}. SID: ${message.sid}`);
    return true;
  } catch (error) {
    console.error(`✗ Error sending SMS to ${phoneNumber}:`, error.message);
    throw error;
  }
}

// Update plate status
function updatePlateStatus(plateId, updates) {
  const plate = monitoringState.plates.find(p => p.id === plateId);
  if (plate) {
    Object.assign(plate, updates);
  }
}

// Main monitoring function - checks all plates
async function performMonitoringCycle() {
  if (!monitoringState.isActive || monitoringState.plates.length === 0) {
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${new Date().toISOString()}] Starting monitoring cycle`);
  console.log(`Checking ${monitoringState.plates.length} plate(s)`);
  console.log('='.repeat(60));

  monitoringState.lastCheckTime = new Date();

  for (const plate of monitoringState.plates) {
    try {
      // Update status to checking
      updatePlateStatus(plate.id, { 
        status: 'checking',
        lastChecked: new Date()
      });

      console.log(`\n🔍 Checking plate: ${plate.plateNumber}`);
      
      // Check EVG for this plate
      const found = await checkEVGForPlate(plate.plateNumber);
      
      if (found && !plate.alertSent) {
        // Fine found and alert not sent yet
        console.log(`🚨 ALERT: Fine found for ${plate.plateNumber}!`);
        
        updatePlateStatus(plate.id, { 
          status: 'found'
        });
        
        // Send SMS
        await sendSMS(plate.phoneNumber, plate.plateNumber);
        
        updatePlateStatus(plate.id, { 
          alertSent: true
        });
        
      } else if (found && plate.alertSent) {
        // Fine found but alert already sent
        console.log(`⚠️  Fine exists for ${plate.plateNumber} (alert already sent)`);
        updatePlateStatus(plate.id, { 
          status: 'found'
        });
        
      } else {
        // No fine found
        console.log(`✓ No fines for ${plate.plateNumber}`);
        updatePlateStatus(plate.id, { 
          status: 'clear',
          alertSent: false // Reset flag when clear
        });
      }
      
      // Small delay between checks to be respectful to EVG servers
      await new Promise(resolve => setTimeout(resolve, 3000));
      
    } catch (error) {
      console.error(`✗ Error checking ${plate.plateNumber}:`, error.message);
      updatePlateStatus(plate.id, { 
        status: 'error'
      });
    }
  }

  console.log(`\n✓ Monitoring cycle completed\n`);
}

// API Endpoints

// Get current monitoring status
app.get('/api/status', (req, res) => {
  res.json({
    isActive: monitoringState.isActive,
    checkInterval: monitoringState.checkInterval,
    plates: monitoringState.plates,
    lastCheckTime: monitoringState.lastCheckTime,
    totalPlates: monitoringState.plates.length,
    activeFines: monitoringState.plates.filter(p => p.status === 'found').length
  });
});

// Add a new plate
app.post('/api/plates/add', (req, res) => {
  const { plateNumber, phoneNumber } = req.body;

  if (!plateNumber || !phoneNumber) {
    return res.status(400).json({ error: 'Plate number and phone number required' });
  }

  // Check if plate already exists
  const exists = monitoringState.plates.find(
    p => p.plateNumber.toUpperCase() === plateNumber.toUpperCase()
  );

  if (exists) {
    return res.status(400).json({ error: 'Plate number already being monitored' });
  }

  const newPlate = {
    id: Date.now().toString(),
    plateNumber: plateNumber.toUpperCase(),
    phoneNumber,
    status: 'pending',
    lastChecked: null,
    alertSent: false
  };

  monitoringState.plates.push(newPlate);

  res.json({ 
    message: 'Plate added successfully',
    plate: newPlate
  });
});

// Remove a plate
app.delete('/api/plates/:id', (req, res) => {
  const { id } = req.params;
  
  const plateIndex = monitoringState.plates.findIndex(p => p.id === id);
  
  if (plateIndex === -1) {
    return res.status(404).json({ error: 'Plate not found' });
  }

  const removed = monitoringState.plates.splice(plateIndex, 1)[0];
  
  res.json({ 
    message: 'Plate removed successfully',
    plate: removed
  });
});

// Update plate details
app.put('/api/plates/:id', (req, res) => {
  const { id } = req.params;
  const { plateNumber, phoneNumber } = req.body;
  
  const plate = monitoringState.plates.find(p => p.id === id);
  
  if (!plate) {
    return res.status(404).json({ error: 'Plate not found' });
  }

  if (plateNumber) plate.plateNumber = plateNumber.toUpperCase();
  if (phoneNumber) plate.phoneNumber = phoneNumber;
  
  res.json({ 
    message: 'Plate updated successfully',
    plate
  });
});

// Start monitoring
app.post('/api/monitoring/start', async (req, res) => {
  const { checkInterval } = req.body;

  if (monitoringState.plates.length === 0) {
    return res.status(400).json({ error: 'No plates to monitor. Add plates first.' });
  }

  monitoringState.isActive = true;
  if (checkInterval) {
    monitoringState.checkInterval = checkInterval;
  }

  // Reset alert flags when starting fresh
  monitoringState.plates.forEach(plate => {
    plate.alertSent = false;
    plate.status = 'pending';
  });

  // Setup new cron job
  setupCronJob(monitoringState.checkInterval);

  // Perform initial check
  performMonitoringCycle();

  res.json({ 
    message: 'Monitoring started',
    checkInterval: monitoringState.checkInterval,
    platesCount: monitoringState.plates.length
  });
});

// Stop monitoring
app.post('/api/monitoring/stop', (req, res) => {
  monitoringState.isActive = false;
  
  if (cronJob) {
    cronJob.stop();
  }

  res.json({ message: 'Monitoring stopped' });
});

// Bulk add plates (for initial setup)
app.post('/api/plates/bulk', (req, res) => {
  const { plates } = req.body;

  if (!Array.isArray(plates)) {
    return res.status(400).json({ error: 'Plates must be an array' });
  }

  const added = [];
  const errors = [];

  plates.forEach(({ plateNumber, phoneNumber }) => {
    if (!plateNumber || !phoneNumber) {
      errors.push({ plateNumber, error: 'Missing plate number or phone number' });
      return;
    }

    const exists = monitoringState.plates.find(
      p => p.plateNumber.toUpperCase() === plateNumber.toUpperCase()
    );

    if (exists) {
      errors.push({ plateNumber, error: 'Already exists' });
      return;
    }

    const newPlate = {
      id: Date.now().toString() + Math.random(),
      plateNumber: plateNumber.toUpperCase(),
      phoneNumber,
      status: 'pending',
      lastChecked: null,
      alertSent: false
    };

    monitoringState.plates.push(newPlate);
    added.push(newPlate);
  });

  res.json({ 
    message: `${added.length} plate(s) added`,
    added,
    errors
  });
});

// Test SMS for a specific plate
app.post('/api/test-sms/:id', async (req, res) => {
  const { id } = req.params;
  
  const plate = monitoringState.plates.find(p => p.id === id);
  
  if (!plate) {
    return res.status(404).json({ error: 'Plate not found' });
  }

  try {
    await sendSMS(plate.phoneNumber, plate.plateNumber);
    res.json({ message: 'Test SMS sent successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cron job management
let cronJob = null;

function setupCronJob(intervalMinutes) {
  if (cronJob) {
    cronJob.stop();
  }
  
  // Create cron expression based on interval
  const cronExpression = `*/${intervalMinutes} * * * *`;
  
  console.log(`Setting up cron job: check every ${intervalMinutes} minutes`);
  
  cronJob = cron.schedule(cronExpression, () => {
    if (monitoringState.isActive) {
      performMonitoringCycle();
    }
  });
}

// Serve static files (optional - for web UI)
app.use(express.static('public'));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`EVG Multi-Plate Monitor Server`);
  console.log(`Running on port ${PORT}`);
  console.log(`Monitoring: ${monitoringState.plates.length} plate(s)`);
  console.log('='.repeat(60) + '\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (cronJob) cronJob.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully');
  if (cronJob) cronJob.stop();
  process.exit(0);
});