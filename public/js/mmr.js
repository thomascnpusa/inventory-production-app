// Immediately log to confirm the file is loaded
console.log('mmr.js loaded at', new Date().toISOString());

// First, immediately execute a script block to ensure the file is loaded
console.log('mmr.js file is loading');

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
        let inventory = await fetchInventoryData();
        if (!inventory || !Array.isArray(inventory)) {
            console.error('Invalid inventory data:', inventory);
            showError('Could not load inventory data properly.');
            return;
        }
        
        console.log(`Loaded ${inventory.length} inventory items`);
        
        const finishedGoods = inventory.filter(item => 
            item.type && item.type.toLowerCase().replace(/\s+/g, '') === 'finishedgood'
        );
        console.log(`Found ${finishedGoods.length} finished goods`);

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
            // Improve the rendering
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
    return $(`<div>
        <strong>${product.product.name}</strong>
        <br><small class="text-muted">SKU: ${product.product.sku}</small>
    </div>`);
}

// Format selected product
function formatProductSelection(product) {
    if (!product.id) return product.text;
    return `${product.product.name} (${product.id})`;
}

// Helper function to fetch inventory data
async function fetchInventoryData() {
    try {
        // First try the authenticated route
        console.log('Attempting to fetch inventory data');
        const response = await authenticatedFetch('/api/inventory');
        if (response && response.ok) {
            const data = await response.json();
            console.log('Successfully fetched inventory data');
            return data;
        } else if (response) {
            console.error('Inventory API returned error status:', response.status);
            throw new Error(`Inventory API error: ${response.status}`);
        }
    } catch (authError) {
        console.error('Authenticated inventory fetch failed:', authError);
        
        // Fall back to the debug route if authentication fails
        try {
            console.log('Trying debug inventory endpoint as fallback');
            const debugResponse = await fetch('/api/debug/inventory');
            if (debugResponse.ok) {
                const data = await debugResponse.json();
                console.log('Successfully fetched inventory data from debug endpoint');
                return data;
            } else {
                console.error('Debug inventory API error:', debugResponse.status);
                throw new Error(`Debug inventory API error: ${debugResponse.status}`);
            }
        } catch (debugError) {
            console.error('Debug inventory fetch failed:', debugError);
            showError('Could not load inventory data. Please check your connection and try again.');
            return [];
        }
    }
    return [];
}

// Search for products and show their MMRs
async function searchProducts(searchTerm) {
    if (!searchTerm || !searchTerm.trim()) {
        showError('Please enter a search term');
        return;
    }
    
    try {
        // First, search for products
        let inventory = [];
        
        try {
            // First try the authenticated route
            const inventoryResponse = await authenticatedFetch('/api/inventory');
            if (inventoryResponse) {
                inventory = await inventoryResponse.json();
            }
        } catch (authError) {
            console.error('Authenticated inventory fetch failed:', authError);
            
            // Fall back to the debug route if authentication fails
            try {
                console.log('Trying debug inventory endpoint as fallback');
                const debugResponse = await fetch('/api/debug/inventory');
                if (debugResponse.ok) {
                    inventory = await debugResponse.json();
                } else {
                    throw new Error('Failed to fetch inventory from debug endpoint');
                }
            } catch (debugError) {
                console.error('Debug inventory fetch failed:', debugError);
                showError('Could not load inventory data. Please check your connection and try again.');
                return;
            }
        }
        
        // Determine if searchTerm is a SKU or a search string
        const isExactSku = inventory.some(item => item.sku && item.sku.toLowerCase() === searchTerm.toLowerCase());
        
        // Filter products based on search term
        let matchingProducts;
        const searchTermLower = searchTerm.toLowerCase();
        
        if (isExactSku) {
            // If it's an exact SKU match, only show that product
            matchingProducts = inventory.filter(item => 
                item.sku && item.sku.toLowerCase() === searchTermLower
            );
            console.log(`Exact SKU match found for "${searchTerm}"`);
        } else {
            // Otherwise, search in both SKU and name
            matchingProducts = inventory.filter(item => 
                (item.type && item.type.toLowerCase().replace(/\s+/g, '') === 'finishedgood') &&
                (item.sku.toLowerCase().includes(searchTermLower) || 
                 item.name.toLowerCase().includes(searchTermLower))
            );
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
        
        // Now get all MMRs
        let mmrs = [];
        
        try {
            // First try the authenticated route
            const mmrResponse = await authenticatedFetch('/api/mmr');
            if (mmrResponse) {
                mmrs = await mmrResponse.json();
                console.log(`Retrieved ${mmrs.length} MMRs from API`);
                
                if (mmrs.length > 0) {
                    // Log the first MMR to see its structure
                    console.log('Sample MMR data:', mmrs[0]);
                    
                    // Log available product SKUs in MMR data
                    const mmrSkus = [...new Set(mmrs.map(mmr => mmr.product_sku || mmr.productSku))];
                    console.log('Available MMR product SKUs:', mmrSkus);
                }
            }
        } catch (authError) {
            console.error('Authenticated MMR fetch failed:', authError);
            
            try {
                // Try the debug route for MMRs as fallback
                console.log('Trying debug MMR endpoint as fallback');
                const debugResponse = await fetch('/api/debug/mmr');
                if (debugResponse.ok) {
                    mmrs = await debugResponse.json();
                    console.log(`Retrieved ${mmrs.length} MMRs from debug API`);
                    
                    if (mmrs.length > 0) {
                        console.log('Sample MMR data (debug):', mmrs[0]);
                        const mmrSkus = [...new Set(mmrs.map(mmr => mmr.product_sku))];
                        console.log('Available MMR product SKUs (debug):', mmrSkus);
                    }
                } else {
                    console.warn('Failed to fetch MMRs from debug endpoint');
                }
            } catch (debugError) {
                console.error('Debug MMR fetch failed:', debugError);
            }
            
            // Continue with empty MMRs array - we'll still show products
        }
        
        // Display results
        const resultsContainer = document.getElementById('mmrSearchResults');
        resultsContainer.innerHTML = '';
        
        // Check the field names in the MMR data to accommodate different API formats
        const usesProductSku = mmrs.length > 0 && 'productSku' in mmrs[0];
        const usesProduct_sku = mmrs.length > 0 && 'product_sku' in mmrs[0];
        
        // Create a card for each product with its MMRs
        matchingProducts.forEach(product => {
            // Handle different field naming conventions and case sensitivity
            const productMMRs = mmrs.filter(mmr => {
                if (usesProductSku && mmr.productSku) {
                    return mmr.productSku.toLowerCase() === product.sku.toLowerCase();
                } else if (usesProduct_sku && mmr.product_sku) {
                    return mmr.product_sku.toLowerCase() === product.sku.toLowerCase();
                }
                return false;
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
                            const productSku = mmr.productSku || mmr.product_sku;
                            const updatedAt = mmr.updatedAt || mmr.updated_at;
                            
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

// Helper function to select a product for new MMR
function selectProductForNewMMR(sku, name) {
    // Pre-fill product selection in the MMR form
    const productSelect = $('#productSkuSearch');
    
    // Check if this option already exists
    let optionExists = false;
    productSelect.find('option').each(function() {
        if ($(this).val() === sku) {
            optionExists = true;
            return false;
        }
    });
    
    // Add the option if it doesn't exist
    if (!optionExists) {
        const newOption = new Option(`${name} (${sku})`, sku, true, true);
        productSelect.append(newOption).trigger('change');
    } else {
        productSelect.val(sku).trigger('change');
    }
    
    // Select the product and scroll to the form
    selectProduct(sku, name);
    document.querySelector('.card-header.bg-success').scrollIntoView({ behavior: 'smooth' });
}

// Set up product search functionality
async function setupProductSearch() {
    try {
        console.log('Setting up product search for MMR creation form');
        // Get inventory data using the shared helper function
        let inventory = await fetchInventoryData();
        
        const finishedGoods = inventory.filter(item => 
            item.type && item.type.toLowerCase().replace(/\s+/g, '') === 'finishedgood'
        );

        // Initialize Select2 for product search in the MMR creation form
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
            // Improve the rendering
            templateResult: formatProduct,
            templateSelection: formatProductSelection
        });

        console.log('MMR form product search Select2 initialized');

        // Handle selection
        $('#productSkuSearch').on('select2:select', function(e) {
            console.log('Product selected in MMR form:', e.params.data);
            const product = e.params.data;
            selectProduct(product.id, product.product.name);
        });

        // Handle clearing
        $('#productSkuSearch').on('select2:clear', function() {
            const selectedProductInfo = document.getElementById('selectedProductInfo');
            if (selectedProductInfo) {
                selectedProductInfo.style.display = 'none';
            }
            const productSku = document.getElementById('productSku');
            if (productSku) {
                productSku.value = '';
            }
        });

    } catch (error) {
        console.error('Error setting up product search:', error);
        showError('Failed to set up product search: ' + error.message);
    }
}

// Helper function to select a product
function selectProduct(sku, name) {
    document.getElementById('productSku').value = sku;
    
    const selectedProductInfo = document.getElementById('selectedProductInfo');
    const selectedProductName = document.getElementById('selectedProductName');
    const selectedProductSku = document.getElementById('selectedProductSku');
    
    if (selectedProductInfo && selectedProductName && selectedProductSku) {
        selectedProductName.textContent = name;
        selectedProductSku.textContent = `SKU: ${sku}`;
        selectedProductInfo.style.display = 'block';
    }
}

// Handle MMR form submission
async function handleMMRSubmit(event) {
    event.preventDefault();
    
    try {
        // Get form data
        const productSku = document.getElementById('productSku').value;
        const baseQuantity = document.getElementById('baseQuantity').value;
        
        if (!productSku || !baseQuantity) {
            showError('Please fill in all required fields');
            return;
        }
        
        // Get ingredients
        const ingredients = Array.from(document.querySelectorAll('#ingredientsList .list-group-item')).map(item => {
            const select = item.querySelector('.ingredient-select');
            const quantity = item.querySelector('.ingredient-quantity');
            const unit = item.querySelector('.unit-type');
            
            if (!select?.value || !quantity?.value || !unit?.value) {
                throw new Error('Please fill in all ingredient fields');
            }
            
            return {
                sku: select.value,
                quantity: parseFloat(quantity.value),
                unit: unit.value
            };
        });
        
        // Get equipment
        const equipment = Array.from(document.querySelectorAll('#equipmentList .list-group-item input')).map(input => {
            if (!input.value) {
                throw new Error('Please fill in all equipment fields');
            }
            
            return {
                name: input.value
            };
        });
        
        // Get steps
        const steps = [];
        const mainSteps = document.querySelectorAll('#stepsList .main-step');
        
        mainSteps.forEach(stepElem => {
            const stepNumber = stepElem.querySelector('.step-number').value;
            const stepTitle = stepElem.querySelector('.step-title').value;
            
            if (!stepNumber || !stepTitle) {
                throw new Error('Please fill in all step fields');
            }
            
            const subSteps = [];
            stepElem.querySelectorAll('.sub-step').forEach(subStepElem => {
                const subStepNumber = subStepElem.querySelector('.substep-number').value;
                const subStepDescription = subStepElem.querySelector('.substep-description').value;
                
                if (!subStepNumber || !subStepDescription) {
                    throw new Error('Please fill in all sub-step fields');
                }
                
                subSteps.push({
                    number: subStepNumber,
                    description: subStepDescription
                });
            });
            
            const qcSteps = [];
            stepElem.querySelectorAll('.qc-step').forEach(qcStepElem => {
                const qcDescription = qcStepElem.querySelector('.qc-description').value;
                
                if (!qcDescription) {
                    throw new Error('Please fill in all QC step fields');
                }
                
                qcSteps.push({
                    description: qcDescription
                });
            });
            
            steps.push({
                number: parseInt(stepNumber),
                title: stepTitle,
                subSteps: subSteps,
                qcSteps: qcSteps
            });
        });
        
        // Get packaging
        const packaging = Array.from(document.querySelectorAll('#packagingList .list-group-item')).map(item => {
            const select = item.querySelector('.packaging-select');
            const quantity = item.querySelector('.packaging-quantity');
            const unit = item.querySelector('.unit-type');
            
            if (!select?.value || !quantity?.value || !unit?.value) {
                throw new Error('Please fill in all packaging fields');
            }
            
            return {
                sku: select.value,
                quantity: parseFloat(quantity.value),
                unit: unit.value
            };
        });
        
        // Get labels
        const labels = Array.from(document.querySelectorAll('#labelsList .list-group-item')).map(item => {
            const select = item.querySelector('.label-select');
            const quantity = item.querySelector('.label-quantity');
            const unit = item.querySelector('.unit-type');
            
            if (!select?.value || !quantity?.value || !unit?.value) {
                throw new Error('Please fill in all label fields');
            }
            
            return {
                sku: select.value,
                quantity: parseFloat(quantity.value),
                unit: unit.value
            };
        });
        
        const createdBy = document.getElementById('createdBy').value;
        if (!createdBy) {
            throw new Error('Please fill in the Created By field');
        }
        
        // Create new MMR object
        const newMMR = {
            productSku,
            baseQuantity: parseFloat(baseQuantity),
            baseUnit: 'units', // Default unit
            ingredients,
            steps,
            equipment,
            packaging,
            labels,
            createdBy
        };
        
        // Send to server using authenticated request
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(newMMR)
        };
        
        const response = await authenticatedFetch('/api/mmr', options);
        if (!response) return; // Redirected to login
        
        const result = await response.json();
        
        showSuccess('MMR created successfully!');
        
        // Redirect to the detail page
        window.location.href = `/mmr-detail.html?sku=${result.productSku}&version=${result.version}&mode=view`;
        
    } catch (error) {
        console.error('Error submitting MMR form:', error);
        showError(error.message || 'Failed to create MMR');
    }
}

// Helper function to show errors
function showError(message) {
    const errorBanner = document.createElement('div');
    errorBanner.className = 'alert alert-danger alert-dismissible fade show';
    errorBanner.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    const container = document.querySelector('.container') || document.body;
    container.insertBefore(errorBanner, container.firstChild);
    
    setTimeout(() => {
        errorBanner.remove();
    }, 5000);
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
    try {
        const mainStep = button.closest('.main-step');
        const subStepsContainer = mainStep.querySelector('.sub-steps-container');
        const template = document.getElementById('subStepTemplate');
        
        if (subStepsContainer && template) {
            const clone = template.content.cloneNode(true);
            subStepsContainer.appendChild(clone);
        }
    } catch (err) {
        console.error('Error adding sub-step:', err);
        showError('Failed to add sub-step: ' + err.message);
    }
}

// Function to add a QC step to a main step
function addQCStep(button) {
    try {
        const mainStep = button.closest('.main-step');
        const subStepsContainer = mainStep.querySelector('.sub-steps-container');
        const template = document.getElementById('qcStepTemplate');
        
        if (subStepsContainer && template) {
            const clone = template.content.cloneNode(true);
            subStepsContainer.appendChild(clone);
        }
    } catch (err) {
        console.error('Error adding QC step:', err);
        showError('Failed to add QC step: ' + err.message);
    }
}

// Function to load inventory options into select dropdowns
async function loadInventoryOptions(selectElement, itemTypes) {
    console.log('Loading inventory options for types:', itemTypes);
    
    try {
        // Fetch inventory data
        const inventory = await fetchInventoryData();
        
        // Filter by the requested types
        const filteredItems = inventory.filter(item => {
            const type = (item.type || '').toLowerCase().replace(/\s+/g, '');
            return itemTypes.some(t => 
                type === t.toLowerCase().replace(/\s+/g, '') || 
                type === t.toLowerCase().replace(/\s+/g, '') + 's' || 
                type === t.toLowerCase().replace(/\s+/g, '').replace('_', '')
            );
        });
        
        console.log(`Found ${filteredItems.length} items for types:`, itemTypes);
        
        // Initialize Select2 for this dropdown
        $(selectElement).select2({
            theme: 'bootstrap-5',
            width: '100%',
            placeholder: 'Search...',
            allowClear: true,
            data: filteredItems.map(item => ({
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
    return $(`<div>
        <strong>${data.item.name}</strong>
        <br><small class="text-muted">SKU: ${data.item.sku}</small>
    </div>`);
}

// Format inventory item for selection display
function formatInventoryItemSelection(data) {
    if (!data.id) return data.text;
    return data.item ? `${data.item.name} (${data.item.sku})` : data.text;
}