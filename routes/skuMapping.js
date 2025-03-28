const express = require('express');
const router = express.Router();
const mapping = require('../mapping');

// Middleware to check authentication (assuming you have this)
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    // Add your token validation logic here
    next();
};

// Get all mappings
router.get('/', authenticate, async (req, res) => {
    try {
        const { platform, search, limit = 100, offset = 0 } = req.query;
        const mappings = await mapping.getAllSkuMappings(platform || null, search || null, parseInt(limit), parseInt(offset));
        const total = await mapping.countSkuMappings(platform || null, search || null);
        res.json({
            mappings,
            total,
            totalPages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Error fetching mappings:', error);
        res.status(500).json({ error: 'Failed to fetch mappings' });
    }
});

// Add a single mapping
router.post('/', authenticate, async (req, res) => {
    const { platformSku, internalSku, platform, productName } = req.body;
    try {
        const success = await mapping.addSkuMapping(platformSku, internalSku, platform, productName);
        if (success) {
            res.status(201).json({ message: 'Mapping added successfully' });
        } else {
            res.status(500).json({ error: 'Failed to add mapping' });
        }
    } catch (error) {
        console.error('Error adding mapping:', error);
        res.status(500).json({ error: 'Failed to add mapping' });
    }
});

// Delete a mapping
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const success = await mapping.deleteSkuMapping(req.params.id);
        if (success) {
            res.json({ message: 'Mapping deleted successfully' });
        } else {
            res.status(500).json({ error: 'Failed to delete mapping' });
        }
    } catch (error) {
        console.error('Error deleting mapping:', error);
        res.status(500).json({ error: 'Failed to delete mapping' });
    }
});

// Bulk upload mappings
router.post('/bulk', authenticate, async (req, res) => {
    const { mappings } = req.body;
    try {
        const result = await mapping.bulkUploadSkuMappings(mappings);
        res.json({ message: `Uploaded ${result.successCount} mappings`, successCount: result.successCount });
    } catch (error) {
        console.error('Error uploading bulk mappings:', error);
        res.status(500).json({ error: 'Failed to upload mappings' });
    }
});

// Suggest mappings
router.get('/suggest/:platform', authenticate, async (req, res) => {
    try {
        const suggestions = await mapping.suggestMappings(req.params.platform);
        res.json({ suggestions });
    } catch (error) {
        console.error('Error suggesting mappings:', error);
        res.status(500).json({ error: 'Failed to suggest mappings' });
    }
});

// Approve suggestions
router.post('/approve-suggestions', authenticate, async (req, res) => {
    const { mappings } = req.body;
    try {
        let successCount = 0;
        for (const { platform, platformSku, internalSku } of mappings) {
            const success = await mapping.approveSuggestion(platform, platformSku, internalSku);
            if (success) successCount++;
        }
        res.json({ message: `Approved ${successCount} mappings`, successCount });
    } catch (error) {
        console.error('Error approving suggestions:', error);
        res.status(500).json({ error: 'Failed to approve suggestions' });
    }
});

module.exports = router;