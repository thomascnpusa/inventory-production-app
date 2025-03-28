const { Pool } = require('pg');
require('dotenv').config();

const pgPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

// Setup the SKU mapping table
async function setupSkuMappingTable() {
    const client = await pgPool.connect();
    try {
        const tableCheck = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'skumapping'
            )
        `);
        const tableExists = tableCheck.rows[0].exists;

        if (!tableExists) {
            await client.query(`
                CREATE TABLE skumapping (
                    id SERIAL PRIMARY KEY,
                    platform_sku VARCHAR(100) NOT NULL,
                    internal_sku VARCHAR(100),
                    platform VARCHAR(50) NOT NULL,
                    product_name VARCHAR(255),
                    confidence FLOAT DEFAULT 0,
                    status VARCHAR(50) DEFAULT 'unmapped',
                    source VARCHAR(50),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(platform_sku, platform)
                )
            `);
            console.log('SKU mapping table created with source column');
        } else {
            // Check if source column exists
            const columnCheck = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.columns 
                    WHERE table_name = 'skumapping' AND column_name = 'source'
                )
            `);
            if (!columnCheck.rows[0].exists) {
                await client.query(`
                    ALTER TABLE skumapping
                    ADD COLUMN source VARCHAR(50)
                `);
                console.log('Added source column to existing skumapping table');
            } else {
                console.log('Source column already exists in skumapping');
            }
        }
    } catch (error) {
        console.error('Error setting up SKU mapping table:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Add or update a SKU mapping
async function addSkuMapping(platformSku, internalSku, platform, productName = null) {
    const client = await pgPool.connect();
    try {
        await client.query(`
            INSERT INTO skumapping (platform_sku, internal_sku, platform, product_name)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (platform_sku, platform) 
            DO UPDATE SET 
                internal_sku = $2,
                product_name = $4,
                updated_at = CURRENT_TIMESTAMP
        `, [platformSku, internalSku, platform, productName]);
        console.log(`Mapped ${platform} SKU ${platformSku} to internal SKU ${internalSku}`);
        return true;
    } catch (error) {
        console.error('Error adding SKU mapping:', error);
        return false;
    } finally {
        client.release();
    }
}

// Get the internal SKU for a platform SKU
async function getInternalSku(platformSku, platform) {
    const client = await pgPool.connect();
    try {
        console.log(`Looking up internal SKU for ${platform} SKU: ${platformSku}`);
        const result = await client.query(
            'SELECT internal_sku FROM skumapping WHERE platform_sku = $1 AND platform = $2',
            [platformSku, platform]
        );
        const foundSku = result.rows.length > 0 ? result.rows[0].internal_sku : null;
        console.log(`Lookup result for ${platform} SKU ${platformSku}: ${foundSku || 'null'}`);
        return foundSku;
    } catch (error) {
        console.error('Error getting internal SKU:', error);
        return null;
    } finally {
        client.release();
    }
}

// Delete a SKU mapping
async function deleteSkuMapping(id) {
    const client = await pgPool.connect();
    try {
        await client.query('DELETE FROM skumapping WHERE id = $1', [id]);
        return true;
    } catch (error) {
        console.error('Error deleting SKU mapping:', error);
        return false;
    } finally {
        client.release();
    }
}

// Get all SKU mappings
async function getAllSkuMappings(platform = null, searchTerm = null, limit = 100, offset = 0) {
    const client = await pgPool.connect();
    try {
        let query = 'SELECT * FROM skumapping WHERE 1=1';
        const params = [];
        let paramIndex = 1;
        
        if (platform) {
            query += ` AND platform = $${paramIndex}`;
            params.push(platform);
            paramIndex++;
        }
        
        if (searchTerm) {
            query += ` AND (platform_sku ILIKE $${paramIndex} OR internal_sku ILIKE $${paramIndex} OR product_name ILIKE $${paramIndex})`;
            params.push(`%${searchTerm}%`);
            paramIndex++;
        }
        
        query += ` ORDER BY platform, platform_sku LIMIT $${paramIndex} OFFSET $${paramIndex+1}`;
        params.push(limit, offset);
        
        const result = await client.query(query, params);
        return result.rows;
    } catch (error) {
        console.error('Error getting SKU mappings:', error);
        return [];
    } finally {
        client.release();
    }
}

// Upload SKU mappings from array
async function bulkUploadSkuMappings(mappings) {
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        
        let successCount = 0;
        let failCount = 0;
        
        for (const mapping of mappings) {
            try {
                await client.query(`
                    INSERT INTO skumapping (platform_sku, internal_sku, platform, product_name)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (platform_sku, platform) 
                    DO UPDATE SET 
                        internal_sku = $2,
                        product_name = $4,
                        updated_at = CURRENT_TIMESTAMP
                `, [mapping.platformSku, mapping.internalSku, mapping.platform, mapping.productName || null]);
                successCount++;
            } catch (error) {
                console.error('Error inserting mapping:', error, mapping);
                failCount++;
            }
        }
        
        await client.query('COMMIT');
        return { successCount, failCount };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error in bulk upload:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function suggestMappings(platform, options = {}) {
    const client = await pgPool.connect();
    console.log(`Suggesting mappings for ${platform}...`);

    const hoursBack = options.hoursBack || 1;
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hoursBack);
    const endDate = new Date();

    try {
        const unmappedQuery = `
            SELECT platform_sku, product_name
            FROM skumapping
            WHERE platform = $1 AND status = 'unmapped'
        `;
        const unmappedResult = await client.query(unmappedQuery, [platform]);
        const unmappedSkus = unmappedResult.rows;

        if (unmappedSkus.length === 0) {
            console.log(`No unmapped ${platform} SKUs found`);
            return [];
        }

        // Prioritize Shopify mapped SKUs as base
        const mappedQuery = `
            SELECT internal_sku, product_name
            FROM skumapping
            WHERE status = 'mapped' AND platform = 'shopify'
        `;
        const mappedResult = await client.query(mappedQuery);
        const mappedSkus = mappedResult.rows;

        const suggestions = [];
        for (const unmapped of unmappedSkus) {
            let bestMatch = null;
            let highestConfidence = 0;

            for (const mapped of mappedSkus) {
                if (unmapped.product_name && mapped.product_name) {
                    const distance = levenshteinDistance(unmapped.product_name.toLowerCase(), mapped.product_name.toLowerCase());
                    const maxLength = Math.max(unmapped.product_name.length, mapped.product_name.length);
                    const confidence = maxLength ? 1 - distance / maxLength : 0;
                    if (confidence > highestConfidence && confidence > 0.75) {
                        bestMatch = mapped.internal_sku;
                        highestConfidence = confidence;
                    }
                }
            }

            suggestions.push({
                platform_sku: unmapped.platform_sku,
                internal_sku: bestMatch,
                confidence: highestConfidence,
                status: bestMatch ? 'suggested' : 'unmapped'
            });
        }

        for (const suggestion of suggestions.filter(s => s.internal_sku)) {
            await client.query(`
                UPDATE skumapping
                SET internal_sku = $1, status = 'suggested', confidence = $2, source = 'auto', updated_at = NOW()
                WHERE platform = $3 AND platform_sku = $4
            `, [suggestion.internal_sku, suggestion.confidence, platform, suggestion.platform_sku]);
        }

        return suggestions;
    } catch (error) {
        console.error('Error suggesting mappings:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function approveSuggestion(platform, platformSku, internalSku) {
    const client = await pgPool.connect();
    try {
        await client.query(`
            UPDATE skumapping
            SET status = 'mapped', source = 'manual', updated_at = NOW()
            WHERE platform = $1 AND platform_sku = $2 AND internal_sku = $3 AND status = 'suggested'
        `, [platform, platformSku, internalSku]);
        console.log(`Approved mapping: ${platform} ${platformSku} -> ${internalSku}`);
        return true;
    } catch (error) {
        console.error('Error approving suggestion:', error);
        return false;
    } finally {
        client.release();
    }
}

// Calculate similarity between two strings
function calculateStringSimilarity(str1, str2) {
    // Convert to lowercase for comparison
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    
    // Check if one is contained in the other
    if (s1.includes(s2) || s2.includes(s1)) {
        return 0.9;
    }
    
    // Calculate Levenshtein distance
    const distance = levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    
    // Return similarity score
    return 1 - (distance / maxLength);
}

// Levenshtein distance calculation
function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    
    // Create matrix
    const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));
    
    // Initialize first row and column
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    
    // Fill in the matrix
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = str1[i-1] === str2[j-1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i-1][j] + 1,      // deletion
                dp[i][j-1] + 1,      // insertion
                dp[i-1][j-1] + cost  // substitution
            );
        }
    }
    
    return dp[m][n];
}

// Count total mappings
async function countSkuMappings(platform = null, searchTerm = null) {
    const client = await pgPool.connect();
    try {
        let query = 'SELECT COUNT(*) as count FROM skumapping WHERE 1=1';
        const params = [];
        let paramIndex = 1;
        
        if (platform) {
            query += ` AND platform = $${paramIndex}`;
            params.push(platform);
            paramIndex++;
        }
        
        if (searchTerm) {
            query += ` AND (platform_sku ILIKE $${paramIndex} OR internal_sku ILIKE $${paramIndex} OR product_name ILIKE $${paramIndex})`;
            params.push(`%${searchTerm}%`);
        }
        
        const result = await client.query(query, params);
        return parseInt(result.rows[0].count);
    } catch (error) {
        console.error('Error counting SKU mappings:', error);
        return 0;
    } finally {
        client.release();
    }
}

// Function to add SKUs to mapping table (helper for Amazon and Shopify integrations)
async function batchAddToMappingTable(skus, platform, productNames = {}) {
    if (!skus || skus.length === 0) return { added: 0, existing: 0 };

    console.log(`Starting transaction for ${skus.length} SKUs for platform ${platform}`);
    console.log(`First few SKUs: ${skus.slice(0, 5).join(', ')}`);

    const client = await pgPool.connect();
    try {
        // Set a transaction timeout to prevent hanging transactions
        await client.query('SET statement_timeout = 60000'); // 60 seconds timeout
        await client.query('BEGIN');
        console.log('Transaction started with 60 second timeout');

        // Check for existing SKUs
        const placeholders = skus.map((_, i) => `$${i + 1}`).join(',');
        const checkQuery = `
            SELECT platform_sku FROM skumapping 
            WHERE platform = $${skus.length + 1} AND platform_sku IN (${placeholders})
        `;
        const params = [...skus, platform];
        console.log(`Checking for existing SKUs: ${skus.join(', ')}`);

        const existingResult = await client.query(checkQuery, params);
        const existingSkus = new Set(existingResult.rows.map(row => row.platform_sku));
        console.log(`Found ${existingSkus.size} existing SKUs: ${Array.from(existingSkus).join(', ')}`);

        const newSkus = skus.filter(sku => !existingSkus.has(sku));
        console.log(`Filtered to ${newSkus.length} new SKUs to add: ${newSkus.join(', ')}`);

        let totalAdded = 0;
        if (newSkus.length > 0) {
            // Insert new SKUs
            const values = newSkus.map(sku => [platform, sku, null, productNames[sku] || null, 0, 'unmapped']).flat();
            const valueStrings = newSkus.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`);
            const insertQuery = `
                INSERT INTO skumapping 
                (platform, platform_sku, internal_sku, product_name, confidence, status) 
                VALUES ${valueStrings.join(',')}
                ON CONFLICT (platform, platform_sku) DO NOTHING
            `;
            console.log(`Executing insert query with ${newSkus.length} SKUs`);
            
            const result = await client.query(insertQuery, values);
            totalAdded = result.rowCount;
            console.log(`Inserted ${totalAdded} new SKUs`);
        }

        console.log('Committing transaction');
        await client.query('COMMIT');
        console.log(`Transaction committed successfully. Added ${totalAdded} new SKUs, ${existingSkus.size} already existed`);
        return { added: totalAdded, existing: existingSkus.size };
    } catch (error) {
        console.error(`Error adding ${platform} SKUs to mapping table:`, error);
        try {
            await client.query('ROLLBACK');
            console.log('Transaction rolled back');
        } catch (rollbackError) {
            console.error('Error during rollback:', rollbackError);
        }
        return { added: 0, existing: 0, error: error.message };
    } finally {
        try {
            // Reset the statement timeout to default
            await client.query('RESET statement_timeout');
        } catch (resetError) {
            console.error('Error resetting timeout:', resetError);
        }
        client.release();
        console.log('Client released');
    }
}

async function setShopifySkusAsInternal() {
    const client = await pgPool.connect();
    try {
        console.log('Setting Shopify SKUs as internal SKUs...');

        // Fetch all unmapped Shopify SKUs
        const unmappedQuery = `
            SELECT platform_sku, product_name
            FROM skumapping
            WHERE platform = 'shopify' AND status = 'unmapped'
        `;
        const unmappedResult = await client.query(unmappedQuery);
        const unmappedSkus = unmappedResult.rows;

        console.log(`Raw unmapped query result: ${JSON.stringify(unmappedSkus)}`);

        if (unmappedSkus.length === 0) {
            console.log('No unmapped Shopify SKUs found to set as internal');
            return { updated: 0 };
        }

        console.log(`Found ${unmappedSkus.length} unmapped Shopify SKUs to update`);

        let updatedCount = 0;
        for (const sku of unmappedSkus) {
            const internalSku = `P-${sku.platform_sku}`; // Add P- prefix, adjust if needed
            console.log(`Preparing to update ${sku.platform_sku} to ${internalSku}`);
            const updateResult = await client.query(`
                UPDATE skumapping
                SET internal_sku = $1, status = 'mapped', source = 'script', updated_at = NOW()
                WHERE platform = 'shopify' AND platform_sku = $2
                RETURNING id
            `, [internalSku, sku.platform_sku]);
            if (updateResult.rowCount > 0) {
                console.log(`Updated ${sku.platform_sku} -> ${internalSku}, ID: ${updateResult.rows[0].id}`);
                updatedCount++;
            } else {
                console.log(`No update for ${sku.platform_sku} - already mapped or missing`);
            }
        }

        console.log(`Updated ${updatedCount} Shopify SKUs to internal SKUs`);
        return { updated: updatedCount };
    } catch (error) {
        console.error('Error setting Shopify SKUs as internal:', error);
        throw error;
    } finally {
        client.release();
        console.log('Client released from setShopifySkusAsInternal');
    }
}

module.exports = {
    setupSkuMappingTable,
    addSkuMapping,
    getInternalSku,
    deleteSkuMapping,
    getAllSkuMappings,
    bulkUploadSkuMappings,
    suggestMappings,
    countSkuMappings,
    batchAddToMappingTable,
    approveSuggestion,
    setShopifySkusAsInternal
};