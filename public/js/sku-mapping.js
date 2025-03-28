// Function to manually import Amazon SKUs
function openAmazonImportModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    
    modal.innerHTML = `
        <div class="modal-content">
            <span class="close">&times;</span>
            <h2>Import Amazon SKUs</h2>
            <p>Paste your Amazon SKUs below (one per line or CSV format)</p>
            <textarea id="amazon-skus-input" rows="10" style="width: 100%; margin-bottom: 15px;"></textarea>
            <p>OR</p>
            <input type="file" id="amazon-skus-file" accept=".csv,.txt">
            <div style="margin-top: 15px;">
                <button id="import-amazon-skus-btn" class="btn btn-primary">Import SKUs</button>
                <button class="btn btn-secondary cancel-btn">Cancel</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close modal when clicking X or Cancel
    modal.querySelector('.close').addEventListener('click', () => {
        document.body.removeChild(modal);
    });
    
    modal.querySelector('.cancel-btn').addEventListener('click', () => {
        document.body.removeChild(modal);
    });
    
    // Handle file input
    document.getElementById('amazon-skus-file').addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(e) {
                document.getElementById('amazon-skus-input').value = e.target.result;
            };
            reader.readAsText(file);
        }
    });
    
    // Handle import button click
    document.getElementById('import-amazon-skus-btn').addEventListener('click', async () => {
        const skusText = document.getElementById('amazon-skus-input').value.trim();
        
        if (!skusText) {
            showNotification('Please enter SKUs or upload a file', 'error');
            return;
        }
        
        // Parse the text to extract SKUs (handle CSV or line-by-line)
        let skus = [];
        
        // Check if it's CSV format (contains commas)
        if (skusText.includes(',')) {
            // Split by commas and clean up
            skus = skusText.split(',').map(sku => sku.trim()).filter(sku => sku);
        } else {
            // Split by new lines
            skus = skusText.split('\n').map(sku => sku.trim()).filter(sku => sku);
        }
        
        if (skus.length === 0) {
            showNotification('No valid SKUs found', 'error');
            return;
        }
        
        try {
            showNotification(`Processing ${skus.length} SKUs...`, 'info');
            
            const response = await fetch('/api/sku-mappings/import-amazon-skus', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ skus })
            });
            
            const result = await response.json();
            
            if (response.ok) {
                showNotification(result.message, 'success');
                document.body.removeChild(modal);
                loadSkuMappings(); // Refresh the mappings list
            } else {
                showNotification(result.error || 'Failed to import SKUs', 'error');
            }
        } catch (error) {
            console.error('Error importing SKUs:', error);
            showNotification('Error importing SKUs', 'error');
        }
    });
}

// Add button to the UI
function addImportButton() {
    const actionsDiv = document.querySelector('.sku-mapping-actions');
    if (actionsDiv) {
        const importBtn = document.createElement('button');
        importBtn.className = 'btn btn-secondary';
        importBtn.textContent = 'Import Amazon SKUs';
        importBtn.addEventListener('click', openAmazonImportModal);
        
        // Insert after the "Add Mapping" button
        const addMappingBtn = actionsDiv.querySelector('button:first-child');
        if (addMappingBtn) {
            actionsDiv.insertBefore(importBtn, addMappingBtn.nextSibling);
        } else {
            actionsDiv.appendChild(importBtn);
        }
    }
}

// Call this function after the page loads
document.addEventListener('DOMContentLoaded', function() {
    // ... existing code ...
    
    // Add the Import Amazon SKUs button
    addImportButton();
}); 