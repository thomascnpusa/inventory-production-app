const alertService = require('../services/alertService');
const cron = require('node-cron');
require('dotenv').config();

// Function to run all automation tasks
async function runAutomationTasks() {
    try {
        console.log('Starting automation tasks...');

        // Check and create alerts
        const alertResults = await alertService.checkAndCreateAlerts();
        console.log('Alert check results:', alertResults);

        // Run procurement automation
        const procurementResults = await alertService.automateProcurement();
        console.log('Procurement automation results:', procurementResults);

        console.log('Automation tasks completed successfully');
    } catch (error) {
        console.error('Error running automation tasks:', error);
    }
}

// Schedule tasks to run daily at 9 AM
cron.schedule('0 9 * * *', runAutomationTasks);

// Also run immediately when the script starts
runAutomationTasks();

// Handle process termination
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Shutting down...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT. Shutting down...');
    process.exit(0);
}); 