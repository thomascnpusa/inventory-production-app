// Simple test script for FBA inventory using Amazon SP-API client
const axios = require('axios');
require('dotenv').config();

// Function to get access token
async function getAccessToken() {
    try {
        console.log('Getting Amazon access token...');
        const response = await axios.post('https://api.amazon.com/auth/o2/token', {
            grant_type: 'refresh_token',
            refresh_token: process.env.AMAZON_REFRESH_TOKEN,
            client_id: process.env.AMAZON_CLIENT_ID,
            client_secret: process.env.AMAZON_CLIENT_SECRET
        });
        console.log('Successfully obtained access token');
        return response.data.access_token;
    } catch (error) {
        console.error('Error getting access token:', error.message);
        throw error;
    }
}

// Function to test FBA inventory
async function testFbaInventory() {
    try {
        const accessToken = await getAccessToken();
        
        // First try the summaries endpoint which is more permissive
        console.log('Testing FBA inventory summaries endpoint...');
        const summariesResponse = await axios.get('https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries', {
            headers: {
                'x-amz-access-token': accessToken,
                'Content-Type': 'application/json'
            },
            params: {
                marketplaceIds: process.env.AMAZON_US_MARKETPLACE_ID || 'ATVPDKIKX0DER',
                granularityType: 'Marketplace',
                granularityId: process.env.AMAZON_US_MARKETPLACE_ID || 'ATVPDKIKX0DER'
            }
        });
        
        console.log('Summaries API response:', JSON.stringify(summariesResponse.data, null, 2));
        
        // Then try the inventories endpoint which is more specific
        console.log('Testing FBA inventory details endpoint...');
        const inventoriesResponse = await axios.get('https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/inventories', {
            headers: {
                'x-amz-access-token': accessToken,
                'Content-Type': 'application/json'
            },
            params: {
                marketplaceIds: process.env.AMAZON_US_MARKETPLACE_ID || 'ATVPDKIKX0DER',
                sellerSkus: '1001,1002,1003',
                granularityType: 'Marketplace',
                granularityId: process.env.AMAZON_US_MARKETPLACE_ID || 'ATVPDKIKX0DER'
            }
        });
        
        console.log('Inventories API response:', JSON.stringify(inventoriesResponse.data, null, 2));
        
        return {
            summaries: summariesResponse.data,
            inventories: inventoriesResponse.data
        };
    } catch (error) {
        console.error('Error testing FBA inventory:', error.message);
        console.error('Status code:', error.response?.status);
        console.error('Error type:', error.response?.headers?.['x-amzn-errortype']);
        console.error('Error data:', JSON.stringify(error.response?.data, null, 2));
        return {
            error: error.message,
            statusCode: error.response?.status,
            errorType: error.response?.headers?.['x-amzn-errortype'],
            errorData: error.response?.data
        };
    }
}

// Create an endpoint to run the test
module.exports = async (req, res) => {
    try {
        const result = await testFbaInventory();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
}; 