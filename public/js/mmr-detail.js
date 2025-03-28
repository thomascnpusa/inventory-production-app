// Log when file loads
console.log('MMR detail script loaded at', new Date().toISOString());

// Variables for the URL params
let productSku = null;
let mmrVersion = null;
let viewMode = 'view'; // Default mode

// DOM ready listener
document.addEventListener('DOMContentLoaded', async function() {
    console.log('DOM content loaded for MMR detail page');
    
    // Check authentication
    if (!isAuthenticated()) {
        console.log('User not authenticated, redirecting to login');
        window.location.href = '/login.html';
        return;
    }
    
    // Parse URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    productSku = urlParams.get('sku');
    mmrVersion = urlParams.get('version');
    const mode = urlParams.get('mode');
    
    if (mode === 'edit') {
        viewMode = 'edit';
    }
    
    // Validate required parameters
    if (!productSku || !mmrVersion) {
        showError('Missing required parameters: SKU and Version are required');
        return;
    }
    
    console.log(`Loading MMR for ${productSku} version ${mmrVersion} in ${viewMode} mode`);
    
    // Update the edit link with the correct URL
    const editMMRLink = document.getElementById('editMMRLink');
    if (editMMRLink) {
        if (viewMode === 'edit') {
            editMMRLink.style.display = 'none'; // Hide edit button in edit mode
        } else {
            editMMRLink.href = `/mmr-edit.html?sku=${productSku}&version=${mmrVersion}`;
        }
    }
    
    // Setup print button
    const printMMRBtn = document.getElementById('printMMR');
    if (printMMRBtn) {
        printMMRBtn.addEventListener('click', function() {
            window.print();
        });
    }
    
    // Load and display MMR data
    await loadMMRDetails();
});

// Function to fetch MMR details from the API
async function loadMMRDetails() {
    try {
        // Show loading indicators
        updateLoadingStatus(true);
        
        let mmrDetails = null;
        
        // Try authenticated API endpoint first
        try {
            console.log(`Fetching MMR data for ${productSku} version ${mmrVersion}`);
            const response = await authenticatedFetch(`/api/mmr/${productSku}/${mmrVersion}`);
            
            if (response && response.ok) {
                mmrDetails = await response.json();
                console.log('Successfully fetched MMR data:', mmrDetails);
            } else {
                console.error('Failed to fetch MMR data, HTTP status:', response?.status);
                throw new Error(`Failed to fetch MMR data: ${response?.statusText || 'Unknown error'}`);
            }
        } catch (authError) {
            console.error('Error with authenticated MMR fetch:', authError);
            
            // Try debug endpoint as fallback
            try {
                console.log('Trying debug MMR endpoint as fallback');
                const debugResponse = await fetch(`/api/debug/mmr/${productSku}/${mmrVersion}`);
                
                if (debugResponse.ok) {
                    mmrDetails = await debugResponse.json();
                    console.log('Successfully fetched MMR data from debug endpoint:', mmrDetails);
                } else {
                    throw new Error(`Debug endpoint failed: ${debugResponse.statusText}`);
                }
            } catch (debugError) {
                console.error('Debug MMR fetch also failed:', debugError);
                throw new Error('Failed to fetch MMR data from both regular and debug endpoints');
            }
        }
        
        // If we still don't have MMR details, show error
        if (!mmrDetails) {
            throw new Error('Failed to fetch MMR details');
        }
        
        // Get product details to show name
        let productDetails = null;
        try {
            const inventoryResponse = await authenticatedFetch(`/api/inventory/${productSku}`);
            if (inventoryResponse && inventoryResponse.ok) {
                productDetails = await inventoryResponse.json();
                console.log('Successfully fetched product details:', productDetails);
            }
        } catch (inventoryError) {
            console.warn('Unable to fetch product details:', inventoryError);
        }
        
        // Update UI with MMR data
        displayMMRDetails(mmrDetails, productDetails);
        
    } catch (error) {
        console.error('Error loading MMR details:', error);
        showError(`Failed to load MMR details: ${error.message}`);
    } finally {
        // Hide loading indicators
        updateLoadingStatus(false);
    }
}

// Display MMR details in the UI
function displayMMRDetails(mmrData, productData) {
    // Convert camelCase to snake_case property access (API has inconsistent naming)
    const getData = (obj, prop) => {
        return obj[prop] || obj[convertToSnakeCase(prop)] || obj[convertToCamelCase(prop)];
    };
    
    // Helper to format dates
    const formatDate = (dateStr) => {
        if (!dateStr) return 'N/A';
        return new Date(dateStr).toLocaleString();
    };
    
    // Update header information
    document.getElementById('productSku').textContent = getData(mmrData, 'productSku');
    document.getElementById('mmrVersion').textContent = getData(mmrData, 'version');
    
    // Format base quantity with unit if available
    const baseQuantity = getData(mmrData, 'baseQuantity') || 'N/A';
    const baseUnit = getData(mmrData, 'baseUnit') || '';
    document.getElementById('baseQuantity').textContent = baseUnit ? `${baseQuantity} ${baseUnit}` : baseQuantity;
    
    // Other metadata
    document.getElementById('createdBy').textContent = getData(mmrData, 'createdBy') || 'N/A';
    document.getElementById('createdAt').textContent = formatDate(getData(mmrData, 'createdAt'));
    document.getElementById('updatedAt').textContent = formatDate(getData(mmrData, 'updatedAt'));
    
    // Product name (from inventory or fallback to SKU)
    if (productData && productData.name) {
        document.getElementById('productName').textContent = productData.name;
    } else {
        document.getElementById('productName').textContent = getData(mmrData, 'productSku');
    }
    
    // Handle ingredients
    const ingredients = getData(mmrData, 'ingredients') || [];
    displayIngredients(ingredients);
    
    // Handle equipment
    const equipment = getData(mmrData, 'equipment') || [];
    displayEquipment(equipment);
    
    // Handle steps
    const steps = getData(mmrData, 'steps') || [];
    displaySteps(steps);
    
    // Handle packaging
    const packaging = getData(mmrData, 'packaging') || [];
    displayPackaging(packaging);
    
    // Handle labels
    const labels = getData(mmrData, 'labels') || [];
    displayLabels(labels);
}

// Display ingredients table
function displayIngredients(ingredients) {
    const tableBody = document.getElementById('ingredientsTableBody');
    const countBadge = document.getElementById('ingredientsCount');
    
    if (countBadge) countBadge.textContent = ingredients.length;
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    
    if (ingredients.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center">No ingredients found</td></tr>`;
        return;
    }
    
    const sortedIngredients = [...ingredients].sort((a, b) => {
        const nameA = (a.ingredient_name || a.ingredientName || '').toLowerCase();
        const nameB = (b.ingredient_name || b.ingredientName || '').toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    sortedIngredients.forEach(ingredient => {
        const row = document.createElement('tr');
        const sku = ingredient.ingredient_sku || ingredient.ingredientSku || '';
        const name = ingredient.ingredient_name || ingredient.ingredientName || '';
        const quantity = ingredient.quantity || '';
        const unit = ingredient.unit_type || ingredient.unitType || ingredient.unit || '';
        const notes = ingredient.notes || '-';
        
        row.innerHTML = `
            <td>${sku}</td>
            <td>${name}</td>
            <td>${quantity}</td>
            <td>${unit}</td>
            <td class="no-print">${notes}</td>
        `;
        tableBody.appendChild(row);
    });
}

// Display equipment list
function displayEquipment(equipment) {
    const equipmentList = document.getElementById('equipmentList');
    const countBadge = document.getElementById('equipmentCount');
    
    if (countBadge) countBadge.textContent = equipment.length;
    if (!equipmentList) return;
    
    equipmentList.innerHTML = '';
    
    if (equipment.length === 0) {
        equipmentList.innerHTML = `<li class="text-center">No equipment found</li>`;
        return;
    }
    
    const sortedEquipment = [...equipment].sort((a, b) => {
        const nameA = (a.equipment_name || a.equipmentName || a.name || '').toLowerCase();
        const nameB = (b.equipment_name || b.equipmentName || b.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    sortedEquipment.forEach(item => {
        const equipmentName = item.equipment_name || item.equipmentName || item.name || '';
        const listItem = document.createElement('li');
        listItem.className = 'equipment-item';
        listItem.innerHTML = `
            <i class="bi bi-tools me-2"></i>
            ${equipmentName}
        `;
        equipmentList.appendChild(listItem);
    });
}

// Display manufacturing steps
function displaySteps(steps) {
    const stepsContainer = document.getElementById('stepsContainer');
    const countBadge = document.getElementById('stepsCount');
    
    if (countBadge) countBadge.textContent = steps.length;
    if (!stepsContainer) return;
    
    stepsContainer.innerHTML = '';
    
    if (steps.length === 0) {
        stepsContainer.innerHTML = `<p class="text-center">No manufacturing steps found</p>`;
        return;
    }
    
    const sortedSteps = [...steps].sort((a, b) => {
        const stepNumA = parseInt(a.step_number || a.stepNumber || 0);
        const stepNumB = parseInt(b.step_number || b.stepNumber || 0);
        return stepNumA - stepNumB;
    });
    
    sortedSteps.forEach(step => {
        const stepNumber = step.step_number || step.stepNumber;
        const stepTitle = step.title || step.description || '';
        const stepType = step.step_type || step.stepType || 'main';
        
        const stepElem = document.createElement('div');
        stepElem.className = 'main-step';
        stepElem.innerHTML = `
            <div class="d-flex align-items-center mb-2">
                <div class="step-number bg-success text-white rounded-circle d-flex align-items-center justify-content-center me-3" 
                     style="width: 36px; height: 36px; flex-shrink: 0;">
                    ${stepNumber}
                </div>
                <h5 class="mb-0">${stepTitle}</h5>
            </div>
        `;
        
        const subSteps = step.subSteps || step.sub_steps || [];
        if (subSteps.length > 0) {
            const sortedSubSteps = [...subSteps].sort((a, b) => {
                const subNumA = a.sub_step_number || a.subStepNumber || '';
                const subNumB = b.sub_step_number || b.subStepNumber || '';
                return subNumA.localeCompare(subNumB, undefined, { numeric: true });
            });
            
            const subStepsContainer = document.createElement('div');
            subStepsContainer.className = 'sub-steps-container mt-3';
            
            sortedSubSteps.forEach(subStep => {
                const subStepNumber = subStep.sub_step_number || subStep.subStepNumber || '';
                const subStepDesc = subStep.description || '';
                const subStepType = subStep.step_type || subStep.stepType || 'sub';
                
                const subStepElem = document.createElement('div');
                
                if (subStepType.toLowerCase() === 'qc') {
                    subStepElem.className = 'qc-step';
                    subStepElem.innerHTML = `
                        <div class="d-flex align-items-center">
                            <span class="badge bg-info me-2">QC</span>
                            <div>${subStepDesc}</div>
                        </div>
                    `;
                } else {
                    subStepElem.className = 'sub-step';
                    subStepElem.innerHTML = `
                        <div class="d-flex">
                            <div class="me-2">${subStepNumber}</div>
                            <div>${subStepDesc}</div>
                        </div>
                    `;
                }
                
                subStepsContainer.appendChild(subStepElem);
            });
            
            stepElem.appendChild(subStepsContainer);
        }
        
        stepsContainer.appendChild(stepElem);
    });
}

// Display packaging table
function displayPackaging(packaging) {
    const tableBody = document.getElementById('packagingTableBody');
    const countBadge = document.getElementById('packagingCount');
    
    if (countBadge) countBadge.textContent = packaging.length;
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    
    if (packaging.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center">No packaging found</td></tr>`;
        return;
    }
    
    packaging.forEach(item => {
        const row = document.createElement('tr');
        const sku = item.packaging_sku || item.packagingSku || item.sku || '';
        const name = item.packaging_name || item.packagingName || item.name || '';
        const quantity = item.quantity || '';
        const unit = item.unit_type || item.unitType || item.unit || '';
        const notes = item.notes || '-';
        
        row.innerHTML = `
            <td>${sku}</td>
            <td>${name}</td>
            <td>${quantity}</td>
            <td>${unit}</td>
            <td class="no-print">${notes}</td>
        `;
        tableBody.appendChild(row);
    });
}

// Display labels table
function displayLabels(labels) {
    const tableBody = document.getElementById('labelsTableBody');
    const countBadge = document.getElementById('labelsCount');
    
    if (countBadge) countBadge.textContent = labels.length;
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    
    if (labels.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center">No labels found</td></tr>`;
        return;
    }
    
    labels.forEach(item => {
        const row = document.createElement('tr');
        const sku = item.label_sku || item.labelSku || item.sku || '';
        const name = item.label_name || item.labelName || item.name || '';
        const quantity = item.quantity || '';
        const unit = item.unit_type || item.unitType || item.unit || '';
        const notes = item.notes || '-';
        
        row.innerHTML = `
            <td>${sku}</td>
            <td>${name}</td>
            <td>${quantity}</td>
            <td>${unit}</td>
            <td class="no-print">${notes}</td>
        `;
        tableBody.appendChild(row);
    });
}

// Helper function to show error message
function showError(message) {
    console.error(message);
    
    const template = document.getElementById('alertTemplate');
    if (!template) return;
    
    const alert = template.content.cloneNode(true);
    alert.querySelector('.alert-message').textContent = message;
    
    const container = document.querySelector('.container');
    if (container) {
        container.insertBefore(alert, container.firstChild);
    }
}

// Helper function to update loading status
function updateLoadingStatus(isLoading) {
    // You can add more sophisticated loading indicators here
    if (!isLoading) {
        // Clear all "loading" messages if we're done loading
        document.querySelectorAll('tbody tr td.text-center, p.text-center, li.text-center').forEach(elem => {
            if (elem.textContent.includes('Loading')) {
                elem.innerHTML = '';
            }
        });
    }
}

// Helper functions for property name conversion
function convertToSnakeCase(camelCase) {
    return camelCase.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function convertToCamelCase(snakeCase) {
    return snakeCase.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}