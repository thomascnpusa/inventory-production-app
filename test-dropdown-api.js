require('dotenv').config();
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const fs = require('fs');

async function testDropdownApi() {
  // Create a test token for API authentication
  const testToken = jwt.sign(
    { userId: 1, username: 'test', role: 'admin' },
    process.env.JWT_SECRET || 'test-secret',
    { expiresIn: '1h' }
  );

  try {
    console.log('Testing API endpoint for product dropdown...');
    
    // This is the exact same endpoint used by the frontend dropdown
    const response = await fetch('http://localhost:3000/api/inventory?type=Finished%20Good', {
      headers: {
        'Authorization': `Bearer ${testToken}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`API response error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log(`API returned response with structure:`, Object.keys(data));
    
    let products = [];
    
    // Handle different possible response formats
    if (data.items && Array.isArray(data.items)) {
      console.log('Response contains "items" array with pagination');
      products = data.items;
      console.log(`Pagination info:`, data.pagination);
    } else if (Array.isArray(data)) {
      console.log('Response is a direct array of products');
      products = data;
    } else {
      console.log('Unexpected response format:', data);
      return;
    }
    
    console.log(`\nAPI returned ${products.length} products`);
    
    // Save products to file for examination
    fs.writeFileSync('api-products.json', JSON.stringify(products, null, 2));
    
    // Check if maitake products are in the results
    const maitakeProducts = products.filter(p => 
      (p.name && p.name.toLowerCase().includes('maitake')) || 
      (p.sku && p.sku === 'FG-2001')
    );
    
    console.log(`\nFound ${maitakeProducts.length} Maitake products in API response:`);
    maitakeProducts.forEach(p => {
      console.log(`- ${p.name} (${p.sku})`);
    });
    
    // Check for any pagination limits
    if (data.pagination) {
      const { currentPage, totalPages, totalItems, limit } = data.pagination;
      console.log(`\nPagination details: page ${currentPage} of ${totalPages}, showing ${limit} of ${totalItems} items`);
      
      if (totalItems > limit) {
        console.log('⚠️ WARNING: Not all products are shown on first page!');
        console.log(`Only seeing ${limit} of ${totalItems} total products.`);
      }
    }
    
    // Check for any size limits on the API response or dropdown
    if (products.length < 262) {
      console.log(`\n⚠️ WARNING: API returning fewer products (${products.length}) than expected (262)`);
    }
    
  } catch (error) {
    console.error('Error testing dropdown API:', error);
  }
}

// Run the function
testDropdownApi(); 