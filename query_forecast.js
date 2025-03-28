require('dotenv').config();
const { Pool } = require('pg');

// Create a new pool instance using credentials from .env
const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT
});

// Query the forecast data for P-1011
async function queryForP1011() {
  try {
    // Fetch sales data with product names (last 90 days, to have data for all time periods)
    const salesQuery = `
      SELECT 
        COALESCE(sm.internal_sku, soi.product_sku) AS product_id,
        COALESCE(ii.name, soi.product_sku) AS product_name,
        SUM(CASE WHEN so.order_date >= NOW() - INTERVAL '30 days' THEN soi.quantity ELSE 0 END) AS units_sold_30d,
        SUM(CASE WHEN so.order_date >= NOW() - INTERVAL '60 days' AND so.order_date < NOW() - INTERVAL '30 days' THEN soi.quantity ELSE 0 END) AS units_sold_30_60d,
        SUM(CASE WHEN so.order_date >= NOW() - INTERVAL '90 days' AND so.order_date < NOW() - INTERVAL '60 days' THEN soi.quantity ELSE 0 END) AS units_sold_60_90d,
        SUM(CASE WHEN so.order_date >= NOW() - INTERVAL '90 days' THEN soi.quantity ELSE 0 END) AS units_sold_90d
      FROM SalesOrderItems soi
      JOIN SalesOrders so ON soi.sales_order_id = so.id
      LEFT JOIN skumapping sm ON soi.product_sku = sm.platform_sku
      LEFT JOIN InventoryItems ii ON COALESCE(sm.internal_sku, soi.product_sku) = ii.sku
      WHERE so.order_date >= NOW() - INTERVAL '90 days'
      AND (COALESCE(sm.internal_sku, soi.product_sku) = 'P-1011' OR COALESCE(ii.name, soi.product_sku) LIKE '%Chanca Piedra%')
      GROUP BY COALESCE(sm.internal_sku, soi.product_sku), COALESCE(ii.name, soi.product_sku), soi.product_sku;
    `;

    // Fetch inventory for P-1011
    const inventoryQuery = `
      SELECT sku, name, type, stock_level
      FROM InventoryItems
      WHERE sku = 'P-1011' OR name LIKE '%Chanca Piedra%';
    `;

    const [salesResult, inventoryResult] = await Promise.all([
      pgPool.query(salesQuery),
      pgPool.query(inventoryQuery),
    ]);

    // Get the sales data
    const sales = salesResult.rows;
    console.log("Sales Data:", sales);

    // Get inventory data
    console.log("Inventory Data:", inventoryResult.rows);

    // Calculate forecasts for P-1011
    if (sales.length > 0) {
      const days30 = 30;
      const days60 = 60;
      const days90 = 90;
      const forecastDays = 30;

      for (const { product_id, product_name, units_sold_30d, units_sold_30_60d, units_sold_60_90d, units_sold_90d } of sales) {
        // Calculate total sales for each period
        const unitsSold60d = Number(units_sold_30d) + Number(units_sold_30_60d);
        
        // Calculate daily averages for each time period
        const avgDaily30d = Number(units_sold_30d) / days30;
        const avgDaily60d = unitsSold60d / days60;
        const avgDaily90d = Number(units_sold_90d) / days90;
        
        // Calculate monthly forecasts for each period (with 10% growth)
        const forecast30d = Math.ceil(avgDaily30d * forecastDays * 1.1);
        const forecast60d = Math.ceil(avgDaily60d * forecastDays * 1.1);
        const forecast90d = Math.ceil(avgDaily90d * forecastDays * 1.1);

        console.log(`\nForecast for ${product_id} (${product_name}):`);
        console.log(`Units sold in last 30 days: ${units_sold_30d}`);
        console.log(`Units sold between 30-60 days ago: ${units_sold_30_60d}`);
        console.log(`Units sold between 60-90 days ago: ${units_sold_60_90d}`);
        console.log(`Total units sold in last 90 days: ${units_sold_90d}`);
        console.log(`\nAverage daily sales (30 days): ${avgDaily30d.toFixed(2)}`);
        console.log(`Average daily sales (60 days): ${avgDaily60d.toFixed(2)}`);
        console.log(`Average daily sales (90 days): ${avgDaily90d.toFixed(2)}`);
        console.log(`\n30-day forecast: ${forecast30d}`);
        console.log(`60-day forecast: ${forecast60d}`);
        console.log(`90-day forecast: ${forecast90d}`);
      }
    } else {
      console.log("No sales data found for P-1011 Chanca Piedra Concentrate");
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Close the connection pool
    await pgPool.end();
  }
}

// Run the query
queryForP1011(); 