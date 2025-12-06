// server.js - Multi-Plate EVG Monitor Backend
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

// Storage for multiple plates
let monitoringState = {
  isActive: false,
  checkInterval: 15,
  plates: [],
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const evgUrl = 'https://evg.ae/_layouts/EVG/gettickets.aspx?language=en&action=bannertcf&key=CxdByg2XNuFSyUYBxNu4Ke759JexznrMypHZ04FijaEilAYneiXTfG4qzD6c4cnb';
    
    console.log(`Navigating to EVG for plate: ${plateNumber}`);
    
    await page.goto(evgUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });

    await page.waitForTimeout(3000);
    const content = await page.content();
    const foundInText = content.toLowerCase().includes(plateNumber.toLowerCase());
    
    const plateElements = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('td, div, span, p'));
      return elements.map(el => el.textContent.trim()).filter(text => text.length > 0);
    });
    
    const foundInElements = plateElements.some(text => 
      text.toUpperCase().includes(plateNumber.toUpperCase())
    );
    
    console.log(`Plate ${plateNumber}: Found=${foundInText || foundInElements}`);
    
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

// Main monitoring function
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
      updatePlateStatus(plate.id, { 
        status: 'checking',
        lastChecked: new Date()
      });

      console.log(`\n🔍 Checking plate: ${plate.plateNumber}`);
      
      const found = await checkEVGForPlate(plate.plateNumber);
      
      if (found && !plate.alertSent) {
        console.log(`🚨 ALERT: Fine found for ${plate.plateNumber}!`);
        updatePlateStatus(plate.id, { status: 'found' });
        await sendSMS(plate.phoneNumber, plate.plateNumber);
        updatePlateStatus(plate.id, { alertSent: true });
        
      } else if (found && plate.alertSent) {
        console.log(`⚠️  Fine exists for ${plate.plateNumber} (alert already sent)`);
        updatePlateStatus(plate.id, { status: 'found' });
        
      } else {
        console.log(`✓ No fines for ${plate.plateNumber}`);
        updatePlateStatus(plate.id, { 
          status: 'clear',
          alertSent: false
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
    } catch (error) {
      console.error(`✗ Error checking ${plate.plateNumber}:`, error.message);
      updatePlateStatus(plate.id, { status: 'error' });
    }
  }

  console.log(`\n✓ Monitoring cycle completed\n`);
}

// API Endpoints
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

app.post('/api/plates/add', (req, res) => {
  const { plateNumber, phoneNumber } = req.body;

  if (!plateNumber || !phoneNumber) {
    return res.status(400).json({ error: 'Plate number and phone number required' });
  }

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

app.post('/api/monitoring/start', async (req, res) => {
  const { checkInterval } = req.body;

  if (monitoringState.plates.length === 0) {
    return res.status(400).json({ error: 'No plates to monitor. Add plates first.' });
  }

  monitoringState.isActive = true;
  if (checkInterval) {
    monitoringState.checkInterval = checkInterval;
  }

  monitoringState.plates.forEach(plate => {
    plate.alertSent = false;
    plate.status = 'pending';
  });

  setupCronJob(monitoringState.checkInterval);
  performMonitoringCycle();

  res.json({ 
    message: 'Monitoring started',
    checkInterval: monitoringState.checkInterval,
    platesCount: monitoringState.plates.length
  });
});

app.post('/api/monitoring/stop', (req, res) => {
  monitoringState.isActive = false;
  
  if (cronJob) {
    cronJob.stop();
  }

  res.json({ message: 'Monitoring stopped' });
});

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

// Cron job management
let cronJob = null;

function setupCronJob(intervalMinutes) {
  if (cronJob) {
    cronJob.stop();
  }
  
  const cronExpression = `*/${intervalMinutes} * * * *`;
  
  console.log(`Setting up cron job: check every ${intervalMinutes} minutes`);
  
  cronJob = cron.schedule(cronExpression, () => {
    if (monitoringState.isActive) {
      performMonitoringCycle();
    }
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`EVG Multi-Plate Monitor Server`);
  console.log(`Running on port ${PORT}`);
  console.log(`Monitoring: ${monitoringState.plates.length} plate(s)`);
  console.log('='.repeat(60) + '\n');
});

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
