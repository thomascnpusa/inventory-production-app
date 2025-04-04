document.addEventListener('DOMContentLoaded', () => {
    console.log('[Procurement JS] DOMContentLoaded event fired.');
    const procurementTableBody = document.getElementById('procurementTableBody');
    const procurementLoading = document.getElementById('procurementLoading');
    const procurementContent = document.getElementById('procurementContent');
    const refreshBtn = document.getElementById('refreshBtn');

    // Function to fetch and display procurement data
    async function loadProcurementData() {
        console.log('Loading procurement data...');
        procurementLoading.style.display = 'block';
        procurementContent.style.display = 'none';
        procurementTableBody.innerHTML = ''; // Clear previous data

        try {
            console.log('[Procurement JS] Attempting to call authenticatedFetch for /api/procurement/mmr...');
            const response = await authenticatedFetch('/api/procurement/mmr', { method: 'GET' });
            console.log('[Procurement JS] authenticatedFetch completed. Status:', response.status);
            const data = await response.json();

            console.log('Procurement data received:', data);

            // Check if data is valid (adjust based on actual API response structure)
            if (!data || !Array.isArray(data.procurementItems)) { 
                console.error('Invalid procurement data structure:', data);
                procurementTableBody.innerHTML = '<tr><td colspan="9" class="text-center text-danger">Error: Failed to load procurement data structure.</td></tr>';
                procurementLoading.style.display = 'none';
                procurementContent.style.display = 'block';
                return;
            }

            if (data.procurementItems.length === 0) {
                procurementTableBody.innerHTML = '<tr><td colspan="9" class="text-center">No procurement suggestions at this time.</td></tr>';
            } else {
                populateTable(data.procurementItems);
            }

        } catch (error) {
            console.error('Error loading procurement data:', error);
            procurementTableBody.innerHTML = `<tr><td colspan="9" class="text-center text-danger">Failed to load procurement data: ${error.message}. Please try again.</td></tr>`;
        } finally {
            procurementLoading.style.display = 'none';
            procurementContent.style.display = 'block';
        }
    }

    // Function to populate the table
    function populateTable(items) {
        procurementTableBody.innerHTML = ''; // Clear previous data just in case

        if (!items || items.length === 0) {
            procurementTableBody.innerHTML = '<tr><td colspan="9" class="text-center">No procurement suggestions at this time.</td></tr>';
            return;
        }

        items.forEach(item => {
            const row = procurementTableBody.insertRow();
            
            // Ensure values are not null/undefined before accessing properties or displaying
            const sku = item.sku || 'N/A';
            const name = item.name || 'N/A';
            const type = item.type || 'N/A';
            const vendor = item.vendor || 'N/A'; 
            const currentStock = item.current_stock !== null && item.current_stock !== undefined ? item.current_stock : 'N/A';
            const minStock = item.min_stock !== null && item.min_stock !== undefined ? item.min_stock : 'N/A'; // Use min_stock
            const suggestedOrderQty = item.suggested_order_qty !== null && item.suggested_order_qty !== undefined ? item.suggested_order_qty : 'N/A';
            const projectedUsage = item.projected_usage || 'N/A'; // Added projected usage display

            row.insertCell().textContent = sku;
            row.insertCell().textContent = name;
            row.insertCell().textContent = type;
            row.insertCell().textContent = vendor;
            row.insertCell().textContent = currentStock;
            row.insertCell().textContent = minStock;
            row.insertCell().textContent = suggestedOrderQty;
            row.insertCell().textContent = projectedUsage;
            
            // Add placeholder for actions if needed
            // row.insertCell().innerHTML = `<button class="btn btn-sm btn-primary">Action</button>`; 
        });
    }

    // Initial load
    loadProcurementData();

    // Refresh button listener
    if (refreshBtn) {
        // ... existing code ...
    }
});
