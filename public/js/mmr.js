// Immediately log to confirm the file is loaded
console.log('mmr.js loaded at', new Date().toISOString());

// First, immediately execute a script block to ensure the file is loaded
console.log('mmr.js file is loading');

// Expose functions to the global scope for HTML event handlers
window.addSubStep = addSubStep;
window.addQCStep = addQCStep;
window.selectProductForNewMMR = selectProductForNewMMR;

// Load MMR data when the page loads
document.addEventListener('DOMContentLoaded', async function() {
    console.log('MMR.js: DOMContentLoaded');
    
    try {
        // Set up MMR search
        await initializeProductAutocomplete();
        
        // Set up product search for MMR creation form
        await setupProductSearch();
        
        // Initialize the form submit handler
        document.getElementById('mmrForm').addEventListener('submit', handleMMRSubmit);
        
        // Expose loadInventoryOptions globally so it can be used by inline scripts
        window.loadInventoryOptions = loadInventoryOptions;
        
        // Pre-fetch inventory data
        await fetchInventoryData();
        
        // Check if we should search for a specific product from URL parameter
        const urlParams = new URLSearchParams(window.location.search);
        const searchSku = urlParams.get('search');
        
        if (searchSku) {
            console.log(`Auto-searching for requested product: ${searchSku}`);
            searchProducts(searchSku);
            
            // Set the search input if it exists
            if ($('#productSearchInput').length) {
                const select = $('#productSearchInput');
                const existingOption = select.find(`option[value="${searchSku}"]`);
                if (existingOption.length) {
                    select.val(searchSku).trigger('change');
                } else {
                    // Create a temporary option until the real data loads
                    const option = new Option(searchSku, searchSku, true, true);
                    select.append(option).trigger('change');
                }
            }
        }
    } catch (error) {
        console.error('Error during MMR page initialization:', error);
        showError('Failed to initialize page: ' + error.message);
    }
});

// Set up product search functionality
async function setupProductSearchFunctionality() {
    console.log('Setting up product search functionality');
    const searchInput = document.getElementById('productSearchInput');
    
    if (searchInput) {
        // Initialize Select2 for the product search
        await initializeProductAutocomplete();
    } else {
        console.warn('Product search input not found');
    }
}

// Initialize product autocomplete with Select2
async function initializeProductAutocomplete() {
    try {
        console.log('Initializing product autocomplete');
        // Get all finished goods from inventory
        let inventoryResponse = await fetchInventoryData();
        console.log('Raw inventory response:', inventoryResponse);
        
        // Check if the response has the expected structure
        let inventory = [];
        if (inventoryResponse && inventoryResponse.items && Array.isArray(inventoryResponse.items)) {
            inventory = inventoryResponse.items;
        } else if (Array.isArray(inventoryResponse)) {
            inventory = inventoryResponse;
        } else {
            console.error('Invalid inventory data format:', inventoryResponse);
            showError('Could not load inventory data properly.');
            return;
        }
        
        console.log(`Loaded ${inventory.length} inventory items`);
        
        // Since fetchInventoryData already filters for finished goods, we use all items directly
        const finishedGoods = inventory;
        
        console.log(`Found ${finishedGoods.length} finished goods`);
        
        if (finishedGoods.length === 0) {
            console.warn('No finished goods found in inventory');
            // Log some samples to understand the data structure
            if (inventory.length > 0) {
                console.log('Sample inventory items:');
                inventory.slice(0, 3).forEach((item, idx) => {
                    console.log(`Item ${idx}:`, item);
                });
            }
        }

        // Make sure jQuery and Select2 are loaded
        if (typeof $ === 'undefined' || typeof $.fn.select2 === 'undefined') {
            console.error('jQuery or Select2 is not loaded');
            showError('Required libraries not loaded. Please refresh the page.');
            return;
        }

        // Initialize Select2 for product search
        $('#productSearchInput').select2({
            theme: 'bootstrap-5',
            width: '100%',
            placeholder: 'Search for a product...',
            allowClear: true,
            data: finishedGoods.map(product => ({
                id: product.sku,
                text: `${product.name} (${product.sku})`,
                product: product
            })),
            templateResult: formatProduct,
            templateSelection: formatProductSelection
        });

        console.log('Product search Select2 initialized');

        // Handle select2 selection to automatically search
        $('#productSearchInput').on('select2:select', function(e) {
            console.log('Product selected in search:', e.params.data);
            const selectedValue = e.params.data.id;
            searchProducts(selectedValue);
        });
        
        // Clear search results when selection is cleared
        $('#productSearchInput').on('select2:clear', function() {
            console.log('Search selection cleared');
            document.getElementById('mmrSearchResults').innerHTML = '';
        });

    } catch (error) {
        console.error('Error setting up product autocomplete:', error);
        showError('Failed to set up product search: ' + error.message);
    }
}

// Format product for dropdown
function formatProduct(product) {
    if (!product.id) return product.text;
    
    // Handle the case where product.product might be undefined
    if (!product.product) {
        return $(`<div>
            <strong>${product.text}</strong>
        </div>`);
    }
    
    return $(`<div>
        <strong>${product.product.name}</strong>
        <br><small class="text-muted">SKU: ${product.product.sku}</small>
    </div>`);
}

// Format selected product
function formatProductSelection(product) {
    if (!product.id) return product.text;
    
    // Handle the case where product.product might be undefined
    if (!product.product) {
        return product.text;
    }
    
    return `${product.product.name} (${product.id})`;
}

// Helper function to fetch inventory data
async function fetchInventoryData() {
    try {
        // Use the type endpoint directly since we know it works
        console.log('Fetching finished goods inventory directly from type endpoint');
        const response = await authenticatedFetch('/api/inventory/type/Finished%20Good');
        
        if (response && response.ok) {
            const data = await response.json();
            console.log('Successfully fetched finished goods data');
            
            // Process the data based on response structure
            let finishedGoods = [];
            if (data && data.items && Array.isArray(data.items)) {
                finishedGoods = data.items;
            } else if (Array.isArray(data)) {
                finishedGoods = data;
            } else {
                console.error('Unexpected inventory data format:', data);
                return { items: [] };
            }
            
            console.log(`Found ${finishedGoods.length} finished goods directly from endpoint`);
            
            // If we didn't get any items, try the lowercase variation as a fallback
            if (finishedGoods.length === 0) {
                console.log('No items found with "Finished Good", trying lowercase variation...');
                const lowercaseResponse = await authenticatedFetch('/api/inventory/type/finished%20good');
                if (lowercaseResponse && lowercaseResponse.ok) {
                    const lowercaseData = await lowercaseResponse.json();
                    let lowercaseItems = [];
                    if (lowercaseData && lowercaseData.items && Array.isArray(lowercaseData.items)) {
                        lowercaseItems = lowercaseData.items;
                    } else if (Array.isArray(lowercaseData)) {
                        lowercaseItems = lowercaseData;
                    }
                    console.log(`Found ${lowercaseItems.length} items with "finished good" (lowercase)`);
                    finishedGoods = finishedGoods.concat(lowercaseItems);
                }
            }
            
            // Return in expected format
            return { items: finishedGoods };
        } else if (response) {
            console.error('Finished goods API returned error status:', response.status);
            throw new Error(`Finished goods API error: ${response.status}`);
        }
    } catch (error) {
        console.error('Finished goods fetch failed:', error);
        
        // Fallback to the main inventory endpoint and filter manually
        try {
            console.log('Falling back to main inventory endpoint');
            const fallbackResponse = await authenticatedFetch('/api/inventory');
            if (fallbackResponse && fallbackResponse.ok) {
                const data = await fallbackResponse.json();
                
                // Process the data
                let allItems = [];
                if (data && data.items && Array.isArray(data.items)) {
                    allItems = data.items;
                } else if (Array.isArray(data)) {
                    allItems = data;
                }
                
                // Filter by type with flexible matching
                const finishedGoods = allItems.filter(item => {
                    if (!item || !item.type) return false;
                    
                    const type = item.type.toLowerCase();
                    return type.includes('finish') && type.includes('good');
                });
                
                console.log(`Fallback found ${finishedGoods.length} finished goods from ${allItems.length} total items`);
                
                return { items: finishedGoods };
            }
        } catch (fallbackError) {
            console.error('Fallback inventory fetch failed:', fallbackError);
        }
        
        // Return empty array wrapped in items property as last resort
        return { items: [] };
    }
}

// Search for products and show their MMRs
async function searchProducts(searchTerm) {
    if (!searchTerm || !searchTerm.trim()) {
        showError('Please enter a search term');
        return;
    }
    
    try {
        console.log(`Searching for product with term: "${searchTerm}"`);
        
        // First, get all products (should already be filtered to finished goods)
        let inventoryResponse = await fetchInventoryData();
        
        // Extract items from the response structure
        let inventory = [];
        if (inventoryResponse && inventoryResponse.items && Array.isArray(inventoryResponse.items)) {
            inventory = inventoryResponse.items;
        } else if (Array.isArray(inventoryResponse)) {
            inventory = inventoryResponse;
        } else {
            console.error('Invalid inventory data format:', inventoryResponse);
            showError('Could not process inventory data properly.');
            return;
        }
        
        console.log(`Searching among ${inventory.length} inventory items for term "${searchTerm}"`);
        
        // If we don't have any items to search, let the user know
        if (inventory.length === 0) {
            document.getElementById('mmrSearchResults').innerHTML = `
                <div class="alert alert-warning">
                    <strong>No products available to search.</strong> 
                    <p>There appear to be no finished goods in the inventory system. Please check your inventory data.</p>
                </div>
            `;
            return;
        }
        
        // Determine if searchTerm is a SKU or a search string
        const searchTermLower = searchTerm.toLowerCase();
        const isExactSku = inventory.some(item => 
            item.sku && item.sku.toLowerCase() === searchTermLower
        );
        
        // Filter products based on search term
        let matchingProducts = [];
        
        if (isExactSku) {
            // If it's an exact SKU match, only show that product
            matchingProducts = inventory.filter(item => 
                item.sku && item.sku.toLowerCase() === searchTermLower
            );
            console.log(`Exact SKU match found for "${searchTerm}"`);
        } else {
            // Otherwise, search in both SKU and name
            matchingProducts = inventory.filter(item => {
                if (!item.sku || !item.name) return false;
                
                return (
                    item.sku.toLowerCase().includes(searchTermLower) || 
                    item.name.toLowerCase().includes(searchTermLower)
                );
            });
        }
        
        console.log(`Found ${matchingProducts.length} matching products for search term "${searchTerm}"`);
        
        if (matchingProducts.length === 0) {
            document.getElementById('mmrSearchResults').innerHTML = `
                <div class="alert alert-info">
                    No products found matching "${searchTerm}"
                </div>
            `;
            return;
        }
        
        // Now get all MMRs for these products
        let mmrs = [];
        
        // For each product, get its MMRs directly - this ensures better matches
        for (const product of matchingProducts) {
            try {
                console.log(`Fetching MMRs for product ${product.sku}`);
                const mmrResponse = await authenticatedFetch(`/api/mmr/${product.sku}`);
                
                if (mmrResponse && mmrResponse.ok) {
                    const productMmrs = await mmrResponse.json();
                    if (Array.isArray(productMmrs)) {
                        mmrs = mmrs.concat(productMmrs);
                        console.log(`Found ${productMmrs.length} MMRs for product ${product.sku}`);
                    } else if (productMmrs && productMmrs.items && Array.isArray(productMmrs.items)) {
                        mmrs = mmrs.concat(productMmrs.items);
                        console.log(`Found ${productMmrs.items.length} MMRs for product ${product.sku}`);
                    } else {
                        console.log(`No MMRs found for product ${product.sku}`);
                    }
                } else {
                    console.warn(`MMR API returned status: ${mmrResponse?.status} for product ${product.sku}`);
                    
                    // Try the debug endpoint as fallback for this product
                    try {
                        const debugResponse = await fetch(`/api/debug/mmr/${product.sku}`);
                        if (debugResponse.ok) {
                            const debugMmrs = await debugResponse.json();
                            if (Array.isArray(debugMmrs)) {
                                mmrs = mmrs.concat(debugMmrs);
                                console.log(`Found ${debugMmrs.length} MMRs for product ${product.sku} via debug endpoint`);
                            } else if (debugMmrs && debugMmrs.items && Array.isArray(debugMmrs.items)) {
                                mmrs = mmrs.concat(debugMmrs.items);
                                console.log(`Found ${debugMmrs.items.length} MMRs for product ${product.sku} via debug endpoint`);
                            }
                        }
                    } catch (debugError) {
                        console.error(`Debug MMR fetch failed for ${product.sku}:`, debugError);
                    }
                }
            } catch (error) {
                console.error(`Error fetching MMRs for product ${product.sku}:`, error);
            }
        }
        
        console.log(`Processing ${mmrs.length} total MMRs for all matching products`);
        
        // Display results
        const resultsContainer = document.getElementById('mmrSearchResults');
        if (!resultsContainer) {
            console.error('Results container element not found');
            showError('Cannot display results - element not found');
            return;
        }
        
        resultsContainer.innerHTML = '';
        
        // Create a card for each product with its MMRs
        matchingProducts.forEach(product => {
            if (!product || !product.sku) {
                console.warn('Skipping invalid product:', product);
                return;
            }
            
            // Handle different field naming conventions and case sensitivity
            const productMMRs = mmrs.filter(mmr => {
                if (!mmr) return false;
                
                // Look for the product SKU in any of the common field names
                const mmrSku = mmr.productSku || mmr.product_sku || mmr.sku;
                if (!mmrSku) return false;
                
                return mmrSku.toLowerCase() === product.sku.toLowerCase();
            });
            
            console.log(`Product ${product.name} (${product.sku}) has ${productMMRs.length} matching MMRs`);
            
            const card = document.createElement('div');
            card.className = 'card mb-3';
            
            // Product header
            const cardHeader = document.createElement('div');
            cardHeader.className = 'card-header';
            cardHeader.innerHTML = `
                <div class="d-flex justify-content-between align-items-center">
                    <h6 class="mb-0">${product.name} (${product.sku})</h6>
                    ${productMMRs.length === 0 ? 
                      `<a href="#" class="btn btn-sm btn-success" onclick="selectProductForNewMMR('${product.sku}', '${product.name}')">
                         <i class="bi bi-plus-circle"></i> Create MMR
                       </a>` : ''}
                </div>
            `;
            card.appendChild(cardHeader);
            
            // Card body with MMRs
            const cardBody = document.createElement('div');
            cardBody.className = 'card-body';
            
            if (productMMRs.length === 0) {
                cardBody.innerHTML = `
                    <p class="card-text text-muted">No MMRs found for this product</p>
                `;
            } else {
                // Create table for MMRs
                const table = document.createElement('table');
                table.className = 'table table-sm table-striped mb-0';
                
                table.innerHTML = `
                    <thead>
                        <tr>
                            <th>Version</th>
                            <th>Base Quantity</th>
                            <th>Last Updated</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${productMMRs.map(mmr => {
                            // Get properties, handling different naming conventions
                            const version = mmr.version;
                            const baseQuantity = mmr.baseQuantity || mmr.base_quantity || '';
                            const baseUnit = mmr.baseUnit || mmr.base_unit || '';
                            const productSku = mmr.productSku || mmr.product_sku || mmr.sku || product.sku;
                            const updatedAt = mmr.updatedAt || mmr.updated_at || new Date().toISOString();
                            
                            return `
                                <tr>
                                    <td>${version}</td>
                                    <td>${baseQuantity} ${baseUnit}</td>
                                    <td>${updatedAt ? new Date(updatedAt).toLocaleString() : 'N/A'}</td>
                                    <td>
                                        <div class="btn-group">
                                            <a href="/mmr-detail.html?sku=${productSku}&version=${version}&mode=view" 
                                               class="btn btn-sm btn-outline-primary">
                                                <i class="bi bi-eye"></i> View
                                            </a>
                                            <a href="/mmr-detail.html?sku=${productSku}&version=${version}&mode=edit" 
                                               class="btn btn-sm btn-outline-secondary">
                                                <i class="bi bi-edit"></i> Edit
                                            </a>
                                        </div>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                `;
                
                cardBody.appendChild(table);
            }
            
            card.appendChild(cardBody);
            resultsContainer.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error searching products:', error);
        showError('Failed to search products: ' + error.message);
    }
}

// Function to select a product for new MMR creation
function selectProductForNewMMR(sku, name) {
    console.log(`Selecting product for new MMR: ${name} (${sku})`);
    
    // Scroll to the MMR form
    const mmrForm = document.getElementById('mmrForm');
    if (mmrForm) {
        mmrForm.scrollIntoView({ behavior: 'smooth' });
    }
    
    // Set the product SKU in the search field and hidden input
    const productSkuSearch = document.getElementById('productSkuSearch');
    const productSku = document.getElementById('productSku');
    const selectedProductInfo = document.getElementById('selectedProductInfo');
    const selectedProductName = document.getElementById('selectedProductName');
    const selectedProductSku = document.getElementById('selectedProductSku');
    
    if (productSkuSearch && window.$ && $.fn.select2) {
        // Create the option if it doesn't exist
        if (!productSkuSearch.querySelector(`option[value="${sku}"]`)) {
            const option = new Option(`${name} (${sku})`, sku, true, true);
            $(productSkuSearch).append(option).trigger('change');
        } else {
            $(productSkuSearch).val(sku).trigger('change');
        }
    }
    
    // Set the hidden input value
    if (productSku) {
        productSku.value = sku;
    }
    
    // Update the selected product info display
    if (selectedProductInfo && selectedProductName && selectedProductSku) {
        selectedProductName.textContent = name;
        selectedProductSku.textContent = `SKU: ${sku}`;
        selectedProductInfo.style.display = 'block';
    }
    
    // Pre-populate some default values in the form
    const baseQuantity = document.getElementById('baseQuantity');
    if (baseQuantity) {
        baseQuantity.value = '100'; // Default base quantity
    }
}

// Set up product search for MMR creation form
async function setupProductSearch() {
    try {
        console.log('Setting up product search for MMR creation');
        
        // Get all products from inventory (should already be filtered to finished goods)
        let inventoryResponse = await fetchInventoryData();
        
        // Extract items from the response structure
        let inventory = [];
        if (inventoryResponse && inventoryResponse.items && Array.isArray(inventoryResponse.items)) {
            inventory = inventoryResponse.items;
        } else if (Array.isArray(inventoryResponse)) {
            inventory = inventoryResponse;
        } else {
            console.error('Invalid inventory data format:', inventoryResponse);
            showError('Could not load inventory data properly for MMR creation.');
            return;
        }
        
        console.log(`Loaded ${inventory.length} inventory items for product selection`);
        
        // Since fetchInventoryData already filters for finished goods, we use all items directly
        const finishedGoods = inventory;
        
        if (finishedGoods.length === 0) {
            console.warn('No finished goods found for product selection');
            return;
        }
        
        // Make sure jQuery and Select2 are loaded
        if (typeof $ === 'undefined' || typeof $.fn.select2 === 'undefined') {
            console.error('jQuery or Select2 is not loaded');
            showError('Required libraries not loaded. Please refresh the page.');
            return;
        }
        
        // Initialize Select2 for product search in the creation form
        $('#productSkuSearch').select2({
            theme: 'bootstrap-5',
            width: '100%',
            placeholder: 'Search for a product...',
            allowClear: true,
            data: finishedGoods.map(product => ({
                id: product.sku,
                text: `${product.name} (${product.sku})`,
                product: product
            })),
            templateResult: formatProduct,
            templateSelection: formatProductSelection
        }).on('select2:select', function(e) {
            const selectedSku = e.params.data.id;
            const selectedProduct = e.params.data.product || finishedGoods.find(p => p.sku === selectedSku);
            
            if (selectedProduct) {
                console.log('Product selected for MMR creation:', selectedProduct);
                
                // Set the hidden input
                document.getElementById('productSku').value = selectedSku;
                
                // Show the selected product info
                const selectedProductInfo = document.getElementById('selectedProductInfo');
                const selectedProductName = document.getElementById('selectedProductName');
                const selectedProductSku = document.getElementById('selectedProductSku');
                
                if (selectedProductInfo && selectedProductName && selectedProductSku) {
                    selectedProductName.textContent = selectedProduct.name;
                    selectedProductSku.textContent = `SKU: ${selectedSku}`;
                    selectedProductInfo.style.display = 'block';
                }
            }
        }).on('select2:clear', function() {
            // Hide the selected product info
            const selectedProductInfo = document.getElementById('selectedProductInfo');
            if (selectedProductInfo) {
                selectedProductInfo.style.display = 'none';
            }
            
            // Clear the hidden input
            const productSku = document.getElementById('productSku');
            if (productSku) {
                productSku.value = '';
            }
        });
        
        console.log('Product selection for MMR creation initialized');
        
    } catch (error) {
        console.error('Error setting up product search for MMR creation:', error);
        showError('Failed to set up product selection: ' + error.message);
    }
}

// Handle MMR form submission
async function handleMMRSubmit(event) {
    event.preventDefault();
    console.log('MMR form submitted');
    
    try {
        // Get form data
        const productSku = document.getElementById('productSku').value;
        const baseQuantity = document.getElementById('baseQuantity').value;
        const createdBy = document.getElementById('createdBy').value;
        
        if (!productSku) {
            showError('Please select a product');
            return;
        }
        
        if (!baseQuantity) {
            showError('Please enter a base quantity');
            return;
        }
        
        if (!createdBy) {
            showError('Please enter who is creating this MMR');
            return;
        }
        
        // Collect ingredients
        const ingredients = [];
        document.querySelectorAll('#ingredientsList .list-group-item').forEach(item => {
            const select = item.querySelector('.ingredient-select');
            const quantity = item.querySelector('.ingredient-quantity');
            const unit = item.querySelector('.unit-type');
            
            if (select && select.value && quantity && quantity.value && unit && unit.value) {
                ingredients.push({
                    sku: select.value,
                    quantity: parseFloat(quantity.value),
                    unit: unit.value
                });
            }
        });
        
        // Collect equipment
        const equipment = [];
        document.querySelectorAll('#equipmentList .list-group-item input').forEach(input => {
            if (input.value) {
                equipment.push({
                    name: input.value
                });
            }
        });
        
        // Collect steps (more complex due to sub-steps)
        const steps = [];
        document.querySelectorAll('#stepsList .main-step').forEach(mainStepEl => {
            const stepNumber = mainStepEl.querySelector('.step-number').value;
            const title = mainStepEl.querySelector('.step-title').value;
            
            if (stepNumber && title) {
                const step = {
                    number: stepNumber,
                    title: title,
                    subSteps: [],
                    qcSteps: []
                };
                
                // Get sub-steps
                mainStepEl.querySelectorAll('.sub-step').forEach(subStepEl => {
                    const subNumber = subStepEl.querySelector('.substep-number').value;
                    const description = subStepEl.querySelector('.substep-description').value;
                    
                    if (subNumber && description) {
                        step.subSteps.push({
                            number: subNumber,
                            description: description
                        });
                    }
                });
                
                // Get QC steps
                mainStepEl.querySelectorAll('.qc-step').forEach(qcStepEl => {
                    const description = qcStepEl.querySelector('.qc-description').value;
                    
                    if (description) {
                        step.qcSteps.push({
                            description: description
                        });
                    }
                });
                
                steps.push(step);
            }
        });
        
        // Collect packaging
        const packaging = [];
        document.querySelectorAll('#packagingList .list-group-item').forEach(item => {
            const select = item.querySelector('.packaging-select');
            const quantity = item.querySelector('.packaging-quantity');
            const unit = item.querySelector('.unit-type');
            
            if (select && select.value && quantity && quantity.value && unit && unit.value) {
                packaging.push({
                    sku: select.value,
                    quantity: parseFloat(quantity.value),
                    unit: unit.value
                });
            }
        });
        
        // Collect labels
        const labels = [];
        document.querySelectorAll('#labelsList .list-group-item').forEach(item => {
            const select = item.querySelector('.label-select');
            const quantity = item.querySelector('.label-quantity');
            const unit = item.querySelector('.unit-type');
            
            if (select && select.value && quantity && quantity.value && unit && unit.value) {
                labels.push({
                    sku: select.value,
                    quantity: parseFloat(quantity.value),
                    unit: unit.value
                });
            }
        });
        
        // Create MMR object
        const mmr = {
            productSku,
            baseQuantity: parseFloat(baseQuantity),
            createdBy,
            ingredients,
            equipment,
            steps,
            packaging,
            labels,
            // Add a default version
            version: '1.0'
        };
        
        console.log('MMR data:', mmr);
        
        // Submit to API
        const response = await authenticatedFetch('/api/mmr', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(mmr)
        });
        
        if (response.ok) {
            const result = await response.json();
            console.log('MMR creation successful:', result);
            
            // Show success message
            alert('MMR created successfully!');
            
            // Refresh the search to see the new MMR
            const productSearchInput = document.getElementById('productSearchInput');
            if (productSearchInput && $(productSearchInput).val()) {
                searchProducts($(productSearchInput).val());
            }
            
            // Reset form
            document.getElementById('mmrForm').reset();
            document.getElementById('selectedProductInfo').style.display = 'none';
            document.getElementById('ingredientsList').innerHTML = '';
            document.getElementById('equipmentList').innerHTML = '';
            document.getElementById('stepsList').innerHTML = '';
            document.getElementById('packagingList').innerHTML = '';
            document.getElementById('labelsList').innerHTML = '';
            $('#productSkuSearch').val(null).trigger('change');
        } else {
            const error = await response.json();
            throw new Error(error.message || 'Failed to create MMR');
        }
    } catch (error) {
        console.error('Error creating MMR:', error);
        showError('Failed to create MMR: ' + error.message);
    }
}

// Show error message
function showError(message) {
    console.error(message);
    alert(message);
}

// Helper function to show success messages
function showSuccess(message) {
    const successBanner = document.createElement('div');
    successBanner.className = 'alert alert-success alert-dismissible fade show';
    successBanner.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    const container = document.querySelector('.container') || document.body;
    container.insertBefore(successBanner, container.firstChild);
    
    setTimeout(() => {
        successBanner.remove();
    }, 3000);
}

// Function to add a sub-step to a main step
function addSubStep(button) {
    const mainStep = button.closest('.main-step');
    if (!mainStep) {
        console.error('Could not find parent main step');
        return;
    }
    
    const subStepsContainer = mainStep.querySelector('.sub-steps-container');
    if (!subStepsContainer) {
        console.error('Could not find sub-steps container');
        return;
    }
    
    // Get the sub-step template
    const template = document.getElementById('subStepTemplate');
    if (!template) {
        console.error('Sub-step template not found');
        return;
    }
    
    const clone = template.content.cloneNode(true);
    subStepsContainer.appendChild(clone);
}

// Function to add a QC step to a main step
function addQCStep(button) {
    const mainStep = button.closest('.main-step');
    if (!mainStep) {
        console.error('Could not find parent main step');
        return;
    }
    
    const subStepsContainer = mainStep.querySelector('.sub-steps-container');
    if (!subStepsContainer) {
        console.error('Could not find sub-steps container');
        return;
    }
    
    // Get the QC step template
    const template = document.getElementById('qcStepTemplate');
    if (!template) {
        console.error('QC step template not found');
        return;
    }
    
    const clone = template.content.cloneNode(true);
    subStepsContainer.appendChild(clone);
}

// Function to load inventory options into select dropdowns
async function loadInventoryOptions(selectElement, itemTypes) {
    console.log('Loading inventory options for types:', itemTypes);
    
    try {
        // For ingredient/packaging searches, we need a different endpoint than finished goods
        // Let's directly use the type-specific endpoint
        let items = [];
        
        for (const type of itemTypes) {
            try {
                const typeResponse = await authenticatedFetch(`/api/inventory/type/${type}`);
                if (typeResponse && typeResponse.ok) {
                    const data = await typeResponse.json();
                    console.log(`Fetched items of type ${type}:`, data);
                    
                    // Extract items from response
                    let typeItems = [];
                    if (data && data.items && Array.isArray(data.items)) {
                        typeItems = data.items;
                    } else if (Array.isArray(data)) {
                        typeItems = data;
                    }
                    
                    items = items.concat(typeItems);
                }
            } catch (typeError) {
                console.error(`Error fetching items of type ${type}:`, typeError);
            }
        }
        
        // If type-specific endpoints failed, fall back to filtering the main inventory
        if (items.length === 0) {
            // Fetch all inventory data
            const inventoryResponse = await authenticatedFetch('/api/inventory');
            if (inventoryResponse && inventoryResponse.ok) {
                const data = await inventoryResponse.json();
                
                // Extract and filter items
                let inventory = [];
                if (data && data.items && Array.isArray(data.items)) {
                    inventory = data.items;
                } else if (Array.isArray(data)) {
                    inventory = data;
                }
                
                // Filter by the requested types
                items = inventory.filter(item => {
                    if (!item || !item.type) return false;
                    
                    const type = item.type.toLowerCase().replace(/\s+/g, '');
                    return itemTypes.some(t => {
                        if (!t) return false;
                        
                        const searchType = t.toLowerCase().replace(/\s+/g, '');
                        return type === searchType || 
                               type.includes(searchType) ||
                               type === searchType + 's' || 
                               type === searchType.replace('_', '');
                    });
                });
            }
        }
        
        console.log(`Found ${items.length} items for types:`, itemTypes);
        
        if (items.length === 0) {
            console.warn('No items found for the specified types:', itemTypes);
        }
        
        // Initialize Select2 for this dropdown
        $(selectElement).select2({
            theme: 'bootstrap-5',
            width: '100%',
            placeholder: 'Search...',
            allowClear: true,
            data: items.map(item => ({
                id: item.sku,
                text: `${item.name} (${item.sku})`,
                item: item
            })),
            templateResult: formatInventoryItem,
            templateSelection: formatInventoryItemSelection
        });
        
        console.log('Select2 initialized for inventory item dropdown');
    } catch (error) {
        console.error('Error loading inventory options:', error);
        alert('Failed to load inventory options: ' + error.message);
    }
}

// Format inventory item for dropdown
function formatInventoryItem(data) {
    if (!data.id) return data.text;
    
    // Handle the case where data.item might be undefined
    if (!data.item) {
        return $(`<div>
            <strong>${data.text}</strong>
        </div>`);
    }
    
    return $(`<div>
        <strong>${data.item.name}</strong>
        <br><small class="text-muted">SKU: ${data.item.sku}</small>
    </div>`);
}

// Format inventory item for selection display
function formatInventoryItemSelection(data) {
    if (!data.id) return data.text;
    
    // Handle the case where data.item might be undefined
    if (!data.item) {
        return data.text;
    }
    
    return `${data.item.name} (${data.item.sku})`;
}