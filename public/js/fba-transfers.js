// FBA Transfers JavaScript Functions

// Define showAlert function if it doesn't exist in the global scope
// This ensures compatibility with the function in index.html
function showAlert(type, message) {
    // If the global showAlert exists, use that instead
    if (window.showAlert && typeof window.showAlert === 'function' && window.showAlert !== this.showAlert) {
        return window.showAlert(type, message);
    }
    
    // Fallback implementation
    const alertsContainer = document.getElementById('alertsContainer');
    if (!alertsContainer) {
        console.error('Alerts container not found');
        alert(message);
        return;
    }
    
    const alertId = 'alert-' + Date.now();
    const alertHtml = `
        <div id="${alertId}" class="alert alert-${type} alert-dismissible fade show" role="alert">
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        </div>
    `;
    
    alertsContainer.innerHTML += alertHtml;
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        const alertElement = document.getElementById(alertId);
        if (alertElement) {
            const bsAlert = new bootstrap.Alert(alertElement);
            bsAlert.close();
        }
    }, 5000);
}

// Load FBA transfers list
async function loadFBATransfers() {
    try {
        const response = await authenticatedFetch('/api/fba/transfers');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        // Clear the table
        const tableBody = document.getElementById('transfersTableBody');
        tableBody.innerHTML = '';
        
        // Add transfers to the table
        if (data.transfers && data.transfers.length > 0) {
            data.transfers.forEach(transfer => {
                const row = document.createElement('tr');
                
                // Set status-based class
                if (transfer.status === 'in_transit') {
                    row.classList.add('table-warning');
                } else if (transfer.status === 'confirmed') {
                    row.classList.add('table-success');
                } else if (transfer.status === 'error') {
                    row.classList.add('table-danger');
                }
                
                row.innerHTML = `
                    <td>${transfer.sku}</td>
                    <td>${transfer.product_name || '-'}</td>
                    <td>${transfer.quantity}</td>
                    <td>${new Date(transfer.transfer_date).toLocaleString()}</td>
                    <td>
                        <span class="badge ${getStatusBadgeClass(transfer.status)}">
                            ${formatStatus(transfer.status)}
                        </span>
                    </td>
                    <td>${transfer.shipment_id || '-'}</td>
                    <td>
                        <div class="btn-group btn-group-sm">
                            <button class="btn btn-outline-primary" onclick="viewTransferDetails(${transfer.id})">
                                <i class="bi bi-eye"></i>
                            </button>
                            ${transfer.status === 'in_transit' ? 
                                `<button class="btn btn-outline-success" onclick="confirmTransfer(${transfer.id})">
                                    <i class="bi bi-check-circle"></i>
                                </button>` : ''}
                        </div>
                    </td>
                `;
                tableBody.appendChild(row);
            });
        } else {
            // No transfers
            const row = document.createElement('tr');
            row.innerHTML = `<td colspan="7" class="text-center">No FBA transfers found</td>`;
            tableBody.appendChild(row);
        }
    } catch (error) {
        console.error('Error loading FBA transfers:', error);
        showAlert('error', 'Failed to load FBA transfers');
    }
}

// Load product SKUs for transfer dropdown
async function loadProductsForTransfer() {
    try {
        // Load products that have Amazon SKU mappings and are finished goods
        const response = await authenticatedFetch('/api/inventory?hasAmazonMapping=true&type=finished good');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        const selectElement = document.getElementById('transferSku');
        selectElement.innerHTML = '<option value="">Select a product</option>';
        
        if (data.items && data.items.length > 0) {
            data.items.forEach(item => {
                const option = document.createElement('option');
                option.value = item.sku;
                option.textContent = `${item.sku} - ${item.name} (Stock: ${item.stock_level})`;
                option.dataset.stock = item.stock_level;
                selectElement.appendChild(option);
            });
            
            // Initialize Select2 for better UX
            $(selectElement).select2({
                theme: 'bootstrap-5',
                dropdownParent: $('#addTransferModal')
            });
            
            // Add change handler to update available stock display
            $(selectElement).on('change', function() {
                const selectedOption = $(this).find(':selected')[0];
                if (selectedOption && selectedOption.dataset.stock) {
                    document.getElementById('availableStock').textContent = selectedOption.dataset.stock;
                    
                    // Check SKU mapping when a product is selected
                    const selectedSku = selectedOption.value;
                    if (selectedSku) {
                        checkSkuMapping(selectedSku);
                    }
                } else {
                    document.getElementById('availableStock').textContent = '-';
                }
            });
        } else {
            // No finished goods with Amazon mappings found
            selectElement.innerHTML = '<option value="">No eligible products found</option>';
            document.getElementById('availableStock').textContent = '-';
        }
    } catch (error) {
        console.error('Error loading products for transfer:', error);
        showAlert('error', 'Failed to load products');
    }
}

// Function to debug SKU mapping
async function checkSkuMapping(sku) {
    try {
        console.log(`Checking Amazon SKU mapping for: ${sku}`);
        
        // Create or clear the status element
        let statusElement = document.getElementById('skuMappingStatus');
        if (!statusElement) {
            statusElement = document.createElement('div');
            statusElement.id = 'skuMappingStatus';
            // Insert after amazonSkuMapping
            const amazonSkuElement = document.getElementById('amazonSkuMapping');
            if (amazonSkuElement && amazonSkuElement.parentNode) {
                amazonSkuElement.parentNode.parentNode.appendChild(statusElement);
            }
        } else {
            statusElement.innerHTML = '';
        }
        
        let data, debugEnabled = false;
        
        try {
            // First try with the specific debug endpoint
            const response = await authenticatedFetch(`/api/debug/sku-mapping/${sku}`);
            if (response.ok) {
                data = await response.json();
                debugEnabled = true;
                console.log(`Debug SKU mapping results for ${sku}:`, data);
            } else if (response.status === 404) {
                // Fallback to the regular SKU mappings endpoint if debug endpoint is not available
                console.log('Debug endpoint not available, falling back to standard SKU mapping endpoint');
                const fallbackResponse = await authenticatedFetch(`/api/sku-mappings?platform=amazon&search=${sku}`);
                if (!fallbackResponse.ok) {
                    throw new Error(`HTTP error! status: ${fallbackResponse.status}`);
                }
                data = await fallbackResponse.json();
                console.log(`Standard SKU mapping results for ${sku}:`, data);
            } else {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            console.error(`Error in primary SKU mapping check: ${error.message}`);
            // Last resort fallback - just try to get all mappings
            const lastResortResponse = await authenticatedFetch('/api/sku-mappings');
            if (!lastResortResponse.ok) {
                throw new Error(`Failed to fetch any SKU mappings: ${lastResortResponse.status}`);
            }
            data = await lastResortResponse.json();
            console.log('Last resort: fetched all SKU mappings', data);
        }
        
        // If we have debug data, show detailed analysis
        if (debugEnabled && data.success) {
            const debugInfo = data.debug_info;
            
            // Show detailed debug info
            const skuFormatInfo = `
                <div class="card mt-2 mb-2">
                    <div class="card-header bg-light">
                        <h6 class="mb-0">SKU Format Analysis</h6>
                    </div>
                    <div class="card-body">
                        <pre>Selected SKU: "${sku}"
Character codes: ${Array.from(sku).map(c => c.charCodeAt(0)).join(', ')}</pre>
                    </div>
                </div>
            `;
            statusElement.innerHTML = skuFormatInfo;
            
            // Check if exact Amazon mapping exists
            const amazonMappings = debugInfo.amazon_mappings || [];
            if (amazonMappings.length > 0) {
                handleFoundMapping(amazonMappings[0], statusElement);
            } else {
                handleNoMapping(sku, debugInfo, statusElement);
            }
        } 
        // Standard endpoint response
        else if (data && data.mappings) {
            // Find Amazon mapping for this SKU
            const mapping = data.mappings.find(m => 
                (m.platform === 'amazon' && m.internal_sku.toLowerCase() === sku.toLowerCase())
            );
            
            if (mapping) {
                handleFoundMapping(mapping, statusElement);
            } else {
                // Simplified no mapping handling
                handleSimpleNoMapping(sku, statusElement);
            }
        } 
        else {
            console.warn(`Unexpected response format for ${sku}`);
            document.getElementById('amazonSkuMapping').textContent = 'Error checking mapping';
            document.getElementById('amazonSkuMapping').classList.add('text-danger');
            document.getElementById('amazonSkuMapping').classList.remove('text-success');
            
            // Show error message
            statusElement.innerHTML = '<div class="alert alert-danger mt-2">Error checking SKU mapping: Unexpected response format.</div>';
        }
    } catch (error) {
        console.error(`Error checking SKU mapping for ${sku}:`, error);
        document.getElementById('amazonSkuMapping').textContent = 'Error checking';
        document.getElementById('amazonSkuMapping').classList.add('text-danger');
        document.getElementById('amazonSkuMapping').classList.remove('text-success');
        
        // Show error message
        const statusElement = document.getElementById('skuMappingStatus') || document.createElement('div');
        statusElement.id = 'skuMappingStatus';
        statusElement.innerHTML = '<div class="alert alert-danger mt-2">Error checking SKU mapping: ' + error.message + '</div>';
        // Insert after amazonSkuMapping if it doesn't exist
        if (!document.getElementById('skuMappingStatus')) {
            const amazonSkuElement = document.getElementById('amazonSkuMapping');
            if (amazonSkuElement && amazonSkuElement.parentNode) {
                amazonSkuElement.parentNode.parentNode.appendChild(statusElement);
            }
        }
    }
}

// Helper function to handle when a mapping is found
function handleFoundMapping(mapping, statusElement) {
    console.log(`Found Amazon mapping:`, mapping);
    document.getElementById('amazonSkuMapping').textContent = mapping.platform_sku || 'N/A';
    document.getElementById('amazonSkuMapping').classList.add('text-success');
    document.getElementById('amazonSkuMapping').classList.remove('text-danger');
    
    // Add a hidden field with the mapping ID for reference
    const mappingIdField = document.getElementById('mappingId') || document.createElement('input');
    mappingIdField.type = 'hidden';
    mappingIdField.id = 'mappingId';
    mappingIdField.value = mapping.id;
    document.getElementById('addTransferForm').appendChild(mappingIdField);
    
    // Show success message
    const successHtml = `
        <div class="alert alert-success mt-2">Valid Amazon SKU mapping found.</div>
        <div class="card mb-2">
            <div class="card-header bg-light">
                <h6 class="mb-0">Mapping Details</h6>
            </div>
            <div class="card-body">
                <table class="table table-sm">
                    <tr>
                        <th>ID</th>
                        <td>${mapping.id}</td>
                    </tr>
                    <tr>
                        <th>Internal SKU</th>
                        <td>${mapping.internal_sku}</td>
                    </tr>
                    <tr>
                        <th>Platform</th>
                        <td>${mapping.platform}</td>
                    </tr>
                    <tr>
                        <th>Platform SKU</th>
                        <td>${mapping.platform_sku}</td>
                    </tr>
                </table>
            </div>
        </div>
    `;
    statusElement.innerHTML += successHtml;
    
    // Re-enable the create transfer button just in case
    document.getElementById('createTransferBtn').disabled = false;
    document.getElementById('createTransferBtn').removeAttribute('title');
}

// Helper function for detailed no mapping scenario
function handleNoMapping(sku, debugInfo, statusElement) {
    console.warn(`No Amazon mappings found for ${sku}`);
    document.getElementById('amazonSkuMapping').textContent = 'Not mapped to Amazon';
    document.getElementById('amazonSkuMapping').classList.add('text-danger');
    document.getElementById('amazonSkuMapping').classList.remove('text-success');
    
    // Add detailed status information about the mapping issue
    let statusHtml = '<div class="alert alert-warning mt-2">';
    statusHtml += '<strong>SKU Mapping Issue:</strong><br>';
    
    // Show case sensitivity issues if any
    if (debugInfo.case_insensitive_matches && debugInfo.case_insensitive_matches.length > 0) {
        statusHtml += 'Found case-insensitive matches: ';
        debugInfo.case_insensitive_matches.forEach(match => {
            statusHtml += `<br>- "${match.internal_sku}" (Platform: ${match.platform}, Platform SKU: ${match.platform_sku})`;
            statusHtml += `<br>&nbsp;&nbsp;Character codes: ${Array.from(match.internal_sku).map(c => c.charCodeAt(0)).join(', ')}`;
        });
    } else if (debugInfo.similar_skus && debugInfo.similar_skus.length > 0) {
        statusHtml += 'Found similar SKUs: ';
        debugInfo.similar_skus.forEach(match => {
            statusHtml += `<br>- "${match.internal_sku}" (Platform: ${match.platform}, Platform SKU: ${match.platform_sku})`;
            statusHtml += `<br>&nbsp;&nbsp;Character codes: ${Array.from(match.internal_sku).map(c => c.charCodeAt(0)).join(', ')}`;
        });
    } else {
        statusHtml += 'No Amazon SKU mapping found for this product.';
        statusHtml += '<br>Please set up a mapping in the SKU Mappings section first.';
    }
    
    statusHtml += `
        <div class="mt-3">
            <button type="button" class="btn btn-primary" id="createMappingButton">
                Create Amazon SKU Mapping
            </button>
        </div>
    `;
    statusHtml += '</div>';
    statusElement.innerHTML += statusHtml;
    
    // Add event listener to the create mapping button
    document.getElementById('createMappingButton').addEventListener('click', function() {
        createMissingMapping(sku);
    });
    
    // Disable the create transfer button
    document.getElementById('createTransferBtn').disabled = true;
    document.getElementById('createTransferBtn').title = 'Amazon SKU mapping required';
}

// Helper function for simple no mapping scenario
function handleSimpleNoMapping(sku, statusElement) {
    console.warn(`No Amazon mappings found for ${sku} in standard response`);
    document.getElementById('amazonSkuMapping').textContent = 'Not mapped to Amazon';
    document.getElementById('amazonSkuMapping').classList.add('text-danger');
    document.getElementById('amazonSkuMapping').classList.remove('text-success');
    
    // Add simplified status information
    let statusHtml = `
        <div class="alert alert-warning mt-2">
            <strong>SKU Mapping Issue:</strong><br>
            No Amazon SKU mapping found for this product.
            <div class="mt-3 d-flex gap-2">
                <button type="button" class="btn btn-primary" id="createMappingButton">
                    Create Amazon SKU Mapping
                </button>
                <button type="button" class="btn btn-warning" id="fixSkuMappingButton">
                    Fix SKU Mapping (Debug)
                </button>
            </div>
        </div>
    `;
    statusElement.innerHTML += statusHtml;
    
    // Add event listener to the create mapping button
    document.getElementById('createMappingButton').addEventListener('click', function() {
        createMissingMapping(sku);
    });
    
    // Add event listener to the fix mapping button
    document.getElementById('fixSkuMappingButton').addEventListener('click', async function() {
        try {
            this.disabled = true;
            this.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Fixing...';
            
            // Call the debug endpoint to fix the mapping
            const response = await fetch(`/api/debug/fix-sku-mapping/${sku}`);
            const data = await response.json();
            
            console.log('Fix SKU mapping response:', data);
            
            if (data.success) {
                showAlert('success', 'SKU mapping fixed! Refreshing...');
                // Re-check the mapping
                setTimeout(() => {
                    checkSkuMapping(sku);
                }, 500);
            } else {
                showAlert('danger', data.message || 'Failed to fix SKU mapping');
            }
        } catch (error) {
            console.error('Error fixing SKU mapping:', error);
            showAlert('danger', error.message || 'Failed to fix SKU mapping');
        } finally {
            this.disabled = false;
            this.innerHTML = 'Fix SKU Mapping (Debug)';
        }
    });
    
    // Disable the create transfer button
    document.getElementById('createTransferBtn').disabled = true;
    document.getElementById('createTransferBtn').title = 'Amazon SKU mapping required';
}

// Create FBA Transfer
async function createFBATransfer() {
    console.log('createFBATransfer function called');
    try {
        // 1. Get form values
        const sku = document.getElementById('transferSku').value;
        const quantity = parseInt(document.getElementById('transferQuantity').value);
        const shipmentId = document.getElementById('shipmentId')?.value || '';
        const trackingNumber = document.getElementById('trackingNumber')?.value || '';
        const notes = document.getElementById('transferNotes')?.value || '';
        
        console.log('Form data:', { sku, quantity, shipmentId, trackingNumber, notes });
        
        // 2. Client-side validation
        if (!sku) {
            showAlert('warning', 'Please select a product');
            return;
        }
        
        if (!quantity || quantity <= 0) {
            showAlert('warning', 'Please enter a valid quantity');
            return;
        }
        
        // Check if there's a valid Amazon SKU mapping
        const amazonSkuMapping = document.getElementById('amazonSkuMapping');
        if (!amazonSkuMapping || 
            amazonSkuMapping.textContent === 'Not mapped to Amazon' || 
            amazonSkuMapping.textContent === 'Error checking' ||
            amazonSkuMapping.textContent === 'Error checking mapping' ||
            amazonSkuMapping.textContent === '-') {
            
            showAlert('warning', 'This product does not have a valid Amazon SKU mapping. Please set up a mapping first.');
            return;
        }
        
        // 4. Update UI - show loading spinner
        document.getElementById('createTransferSpinner').classList.remove('d-none');
        document.getElementById('createTransferBtn').disabled = true;
        
        // 5. Prepare request
        const userData = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')) : null;
        const userId = userData ? userData.id : null;
        
        // Include all form fields in the request
        const requestBody = {
            sku: sku,
            quantity: Number(quantity),
            user_id: userId,
            shipment_id: shipmentId,
            tracking_number: trackingNumber,
            notes: notes
        };
        console.log('Sending API request to /api/fba/transfers with data:', requestBody);
        
        // Check auth token and user data
        const token = localStorage.getItem('token');
        console.log('Auth check:', { 
            hasToken: !!token, 
            hasUserData: !!userData,
            userData: userData
        });
        
        // 6. Send API request
        const response = await authenticatedFetch('/api/fba/transfers', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });
        
        // 7. Log response details
        console.log('API response status:', response.status);
        console.log('API response headers:', [...response.headers.entries()]);
        
        let responseData;
        try {
            // 8. Parse response body
            responseData = await response.json();
            console.log('API response data:', responseData);
        } catch (parseError) {
            console.error('Error parsing response JSON:', parseError);
            responseData = { message: 'Invalid response format from server' };
        }
        
        // 9. Check for errors
        if (!response.ok) {
            console.error('Server error response:', {
                status: response.status,
                statusText: response.statusText,
                data: responseData
            });
            
            // Use the specific error message from the server if available
            const errorMessage = responseData.message || 
                               responseData.error || 
                               responseData.msg || 
                               `Server error: ${response.status} ${response.statusText}`;
            
            showAlert('danger', errorMessage);
            throw new Error(errorMessage);
        }
        
        // 10. Success - update UI
        showAlert('success', 'FBA transfer created successfully');
        
        // 11. Close modal
        console.log('Hiding modal and refreshing data');
        const modalElement = document.getElementById('addTransferModal');
        if (modalElement) {
            const modal = bootstrap.Modal.getInstance(modalElement);
            if (modal) {
                modal.hide();
            } else {
                // Fallback to jQuery
                try {
                    $('#addTransferModal').modal('hide');
                } catch (e) {
                    console.error('Error hiding modal:', e);
                }
            }
        }
        
        // 12. Refresh data
        loadFBATransfers();
        
        // 13. Also refresh inventory to reflect updated stock levels
        if (typeof loadInventoryItems === 'function') {
            loadInventoryItems();
        }
    } catch (error) {
        console.error('Error creating FBA transfer:', error);
        showAlert('danger', error.message || 'Failed to create transfer');
    } finally {
        // 14. Hide loading spinner
        document.getElementById('createTransferSpinner').classList.add('d-none');
        document.getElementById('createTransferBtn').disabled = false;
    }
}

// Function to clear SKU mapping status when modal is closed
function clearSkuMappingStatus() {
    const amazonSkuMapping = document.getElementById('amazonSkuMapping');
    if (amazonSkuMapping) {
        amazonSkuMapping.textContent = '-';
        amazonSkuMapping.classList.remove('text-success', 'text-danger');
    }
    
    const statusElement = document.getElementById('skuMappingStatus');
    if (statusElement) {
        statusElement.innerHTML = '';
    }
    
    // Re-enable the create transfer button
    const createTransferBtn = document.getElementById('createTransferBtn');
    if (createTransferBtn) {
        createTransferBtn.disabled = false;
        createTransferBtn.removeAttribute('title');
    }
}

// Make createFBATransfer available in the global scope
window.createFBATransfer = createFBATransfer;

// Confirm Transfer function (for when items are received by Amazon)
async function confirmTransfer(transferId) {
    if (!confirm('Are you sure this transfer has been received by Amazon?')) {
        return;
    }
    
    try {
        const response = await authenticatedFetch(`/api/fba/transfers/${transferId}/confirm`, {
            method: 'PUT'
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to confirm transfer');
        }
        
        showAlert('success', 'Transfer marked as confirmed');
        loadFBATransfers();
    } catch (error) {
        console.error('Error confirming transfer:', error);
        showAlert('error', error.message || 'Failed to confirm transfer');
    }
}

// View transfer details
async function viewTransferDetails(transferId) {
    try {
        const response = await authenticatedFetch(`/api/fba/transfers/${transferId}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const transfer = await response.json();
        
        // Create a modal to display the details
        // This is just a placeholder - you might want to create a proper modal in the HTML
        alert(`
            Transfer Details:
            SKU: ${transfer.sku}
            Quantity: ${transfer.quantity}
            Status: ${transfer.status}
            Shipment ID: ${transfer.shipment_id || 'N/A'}
            Tracking: ${transfer.tracking_number || 'N/A'}
            Notes: ${transfer.notes || 'N/A'}
        `);
    } catch (error) {
        console.error('Error viewing transfer details:', error);
        showAlert('error', 'Failed to load transfer details');
    }
}

// Helper functions
function getStatusBadgeClass(status) {
    switch (status) {
        case 'in_transit': return 'bg-warning';
        case 'confirmed': return 'bg-success';
        case 'reconciled': return 'bg-info';
        case 'error': return 'bg-danger';
        default: return 'bg-secondary';
    }
}

function formatStatus(status) {
    return status.replace('_', ' ').split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

// Initialize the transfers tab
document.addEventListener('DOMContentLoaded', function() {
    console.log('FBA Transfers: DOM Content Loaded');
    
    // Add event listener for FBA transfers tab
    const transfersTab = document.getElementById('fba-transfers-tab');
    if (transfersTab) {
        console.log('Found transfers tab, adding click listener');
        transfersTab.addEventListener('click', function() {
            loadFBATransfers();
        });
    }
    
    // Add event listener for transfer modal open
    const addTransferModal = document.getElementById('addTransferModal');
    if (addTransferModal) {
        console.log('Found transfer modal, adding show.bs.modal listener');
        addTransferModal.addEventListener('show.bs.modal', function() {
            loadProductsForTransfer();
            document.getElementById('transferQuantity').value = '';
            document.getElementById('shipmentId').value = '';
            document.getElementById('trackingNumber').value = '';
            document.getElementById('transferNotes').value = '';
            document.getElementById('availableStock').textContent = '-';
        });
        
        // Add event listener for modal close
        addTransferModal.addEventListener('hidden.bs.modal', function() {
            console.log('Transfer modal closed, clearing SKU mapping status');
            clearSkuMappingStatus();
        });
    }
    
    // Add event listener for create transfer button
    const createTransferBtn = document.getElementById('createTransferBtn');
    if (createTransferBtn) {
        console.log('Found create transfer button, adding click listener');
        createTransferBtn.addEventListener('click', function() {
            console.log('Create Transfer button clicked');
            createFBATransfer();
        });
    } else {
        console.error('Create Transfer button not found in DOM');
    }
    
    console.log('FBA Transfers initialization complete');
});

// Make all the functions available in the global scope
window.createFBATransfer = createFBATransfer;
window.confirmTransfer = confirmTransfer;
window.viewTransferDetails = viewTransferDetails;
window.loadFBATransfers = loadFBATransfers;
window.checkSkuMapping = checkSkuMapping;
window.clearSkuMappingStatus = clearSkuMappingStatus;
window.createMissingMapping = createMissingMapping;

// Function to create missing Amazon SKU mapping
async function createMissingMapping(sku) {
    try {
        // 1. Add a form to the status element for creating a mapping
        const statusElement = document.getElementById('skuMappingStatus');
        if (!statusElement) return;
        
        const formHtml = `
            <div class="card mb-3">
                <div class="card-header bg-primary text-white">
                    <h6 class="mb-0">Create Amazon SKU Mapping</h6>
                </div>
                <div class="card-body">
                    <form id="createMappingForm">
                        <div class="mb-3">
                            <label for="internalSku" class="form-label">Internal SKU</label>
                            <input type="text" class="form-control" id="internalSku" value="${sku}" readonly>
                        </div>
                        <div class="mb-3">
                            <label for="platformSku" class="form-label">Amazon SKU</label>
                            <input type="text" class="form-control" id="platformSku" required placeholder="Enter the Amazon SKU...">
                            <div class="form-text">This must match exactly with the SKU in your Amazon Seller Central.</div>
                        </div>
                        <div class="d-grid">
                            <button type="button" class="btn btn-primary" id="saveMappingBtn">
                                <span id="saveMappingSpinner" class="spinner-border spinner-border-sm d-none" role="status"></span>
                                Create Mapping
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        
        // Add the form to the status element
        statusElement.innerHTML += formHtml;
        
        // 2. Add event listener to the save button
        document.getElementById('saveMappingBtn').addEventListener('click', async function() {
            const platformSku = document.getElementById('platformSku').value;
            
            if (!platformSku) {
                showAlert('warning', 'Please enter the Amazon SKU');
                return;
            }
            
            // Show loading spinner
            document.getElementById('saveMappingSpinner').classList.remove('d-none');
            this.disabled = true;
            
            try {
                // 3. Create the mapping using the SKU mapping API
                const response = await authenticatedFetch('/api/sku-mappings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        internal_sku: sku,
                        platform_sku: platformSku,
                        platform: 'amazon'
                    })
                });
                
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || 'Failed to create SKU mapping');
                }
                
                // 4. Show success message
                showAlert('success', 'Amazon SKU mapping created successfully');
                
                // 5. Re-check the SKU mapping
                setTimeout(() => {
                    checkSkuMapping(sku);
                }, 500);
            } catch (error) {
                console.error('Error creating SKU mapping:', error);
                showAlert('danger', error.message || 'Failed to create SKU mapping');
            } finally {
                // 6. Hide loading spinner
                document.getElementById('saveMappingSpinner').classList.add('d-none');
                this.disabled = false;
            }
        });
    } catch (error) {
        console.error('Error setting up mapping form:', error);
        showAlert('danger', 'Error setting up mapping form');
    }
} 