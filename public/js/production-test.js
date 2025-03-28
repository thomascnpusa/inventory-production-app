/**
 * Production Order Completion Test
 * 
 * This script automates testing the production order completion flow.
 * It creates a test order, completes all steps, and verifies the final status.
 */

// Configuration variables
const config = {
    productSku: 'TEST-PROD-001', // Use a test product SKU from your inventory
    quantity: 10,
    testUserInitials: 'TST'
};

// Store references to created resources for cleanup
let testOrderId = null;

// Initialize the test
async function initTest() {
    displayStatus('Starting production order completion test...');
    
    try {
        // Step 1: Create a test production order
        await createTestOrder();
        
        // Step 2: Complete all steps
        await completeAllSteps();
        
        // Step 3: Mark order as completed
        await markOrderAsCompleted();
        
        // Step 4: Verify order status
        await verifyOrderStatus();
        
        displayStatus('Test completed successfully! ✅', 'success');
    } catch (error) {
        displayStatus(`Test failed: ${error.message}`, 'danger');
        console.error('Test error:', error);
    }
}

// Create a test production order
async function createTestOrder() {
    displayStatus('Creating test production order...');
    
    const payload = {
        product_sku: config.productSku,
        quantity: config.quantity,
        due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // 7 days from now
    };
    
    const response = await authenticatedFetch('/api/v1/production-orders/simple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
        const data = await response.json();
        throw new Error(`Failed to create test order: ${data.error || response.statusText}`);
    }
    
    const data = await response.json();
    testOrderId = data.order_id;
    displayStatus(`Created test order #${testOrderId}`, 'info');
    return testOrderId;
}

// Complete all steps in the order
async function completeAllSteps() {
    displayStatus(`Fetching steps for order #${testOrderId}...`);
    
    // Get all steps for the order
    const stepsResponse = await authenticatedFetch(`/api/v1/production-orders/${testOrderId}/steps`);
    
    if (!stepsResponse.ok) {
        const data = await stepsResponse.json();
        throw new Error(`Failed to get steps: ${data.error || stepsResponse.statusText}`);
    }
    
    const steps = await stepsResponse.json();
    displayStatus(`Found ${steps.length} steps to complete`, 'info');
    
    // Complete each step in sequence
    for (const step of steps) {
        await completeStep(step.id);
    }
    
    displayStatus(`All ${steps.length} steps completed!`, 'success');
}

// Complete a single step
async function completeStep(stepId) {
    displayStatus(`Completing step #${stepId}...`);
    
    const payload = {
        completed: true,
        completed_by: config.testUserInitials,
        completed_date: new Date().toISOString()
    };
    
    const response = await authenticatedFetch(`/api/v1/production-orders/${testOrderId}/steps/${stepId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
        const data = await response.json();
        throw new Error(`Failed to complete step ${stepId}: ${data.error || response.statusText}`);
    }
    
    displayStatus(`Step #${stepId} completed`, 'info');
}

// Mark the order as completed
async function markOrderAsCompleted() {
    displayStatus(`Marking order #${testOrderId} as completed...`);
    
    const response = await authenticatedFetch(`/api/v1/production-orders/${testOrderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' })
    });
    
    if (!response.ok) {
        const data = await response.json();
        throw new Error(`Failed to complete order: ${data.error || response.statusText}`);
    }
    
    displayStatus(`Order #${testOrderId} marked as completed`, 'success');
}

// Verify the order status was updated correctly
async function verifyOrderStatus() {
    displayStatus(`Verifying status of order #${testOrderId}...`);
    
    const response = await authenticatedFetch(`/api/v1/production-orders/${testOrderId}`);
    
    if (!response.ok) {
        const data = await response.json();
        throw new Error(`Failed to get order details: ${data.error || response.statusText}`);
    }
    
    const order = await response.json();
    
    if (order.status !== 'Completed') {
        throw new Error(`Order status is "${order.status}" but expected "Completed"`);
    }
    
    displayStatus(`Order status verified: ${order.status}`, 'success');
}

// Display test status in the UI
function displayStatus(message, type = 'primary') {
    const statusContainer = document.getElementById('testStatus');
    
    const statusItem = document.createElement('div');
    statusItem.className = `alert alert-${type} mb-2`;
    statusItem.innerHTML = message;
    
    statusContainer.appendChild(statusItem);
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    // Scroll to bottom
    statusContainer.scrollTop = statusContainer.scrollHeight;
}

// Event listeners
document.addEventListener('DOMContentLoaded', function() {
    const runTestBtn = document.getElementById('runTestBtn');
    
    if (runTestBtn) {
        runTestBtn.addEventListener('click', function() {
            // Clear previous test results
            document.getElementById('testStatus').innerHTML = '';
            
            // Run the test
            initTest();
        });
    }
}); 