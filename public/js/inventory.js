document.addEventListener('DOMContentLoaded', function() {
    // Check if we're on an inventory page
    const inventoryTable = document.getElementById('inventory-table');
    if (!inventoryTable) return;
    
    // Add sync FBA inventory button if it doesn't exist
    const syncFbaButton = document.getElementById('sync-fba-button');
    if (syncFbaButton) {
        syncFbaButton.addEventListener('click', syncFbaInventory);
    }
    
    // Function to sync FBA inventory
    function syncFbaInventory() {
        const button = document.getElementById('sync-fba-button');
        button.disabled = true;
        button.innerHTML = '<i class="bi bi-spinner spin"></i> Syncing...';
        
        fetch('/api/v1/sync/fba-inventory', {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + localStorage.getItem('token')
            }
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (data.success) {
                showNotification(`FBA inventory synced successfully. Updated ${data.updated || 0} SKUs.`, 'success');
                // Reload the page to show updated inventory
                setTimeout(() => location.reload(), 1500);
            } else {
                showNotification('Error syncing FBA inventory: ' + (data.message || 'Unknown error'), 'error');
            }
        })
        .catch(error => {
            console.error('Error syncing FBA inventory:', error);
            showNotification('Error syncing FBA inventory: ' + error.message, 'error');
        })
        .finally(() => {
            button.disabled = false;
            button.innerHTML = '<i class="bi bi-sync"></i> Sync FBA Inventory';
        });
    }
    
    // Function to show notifications
    function showNotification(message, type) {
        const alertsContainer = document.getElementById('alertsContainer');
        if (!alertsContainer) return;
        
        const notification = document.createElement('div');
        notification.className = `alert alert-${type === 'error' ? 'danger' : 'success'} alert-dismissible fade show`;
        notification.role = 'alert';
        notification.innerHTML = `
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        
        alertsContainer.appendChild(notification);
        
        // Auto-dismiss after 5 seconds
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => {
                notification.remove();
            }, 300);
        }, 5000);
    }
}); 