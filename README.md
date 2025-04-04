# Inventory Production App

This application manages inventory and production processes.

## Amazon FBA Inventory Integration

The application now includes FBA inventory data alongside warehouse inventory. This gives you a complete picture of your total available inventory across all channels.

### Features

- **FBA Inventory Column**: View FBA inventory levels directly in the inventory table
- **Total Available**: See the sum of warehouse inventory + FBA inventory
- **Manual Sync**: Use the "Sync FBA Inventory" button to refresh FBA inventory data

### Implementation Details

The system uses Amazon order history to estimate FBA inventory levels since direct API access is pending. When full API permissions are granted, the system will automatically switch to using real-time FBA inventory data from Amazon's Selling Partner API.

### Future Enhancements

- Direct integration with Amazon's FBA Inventory API (pending permissions)
- Historical tracking of FBA inventory levels
- Alerts for low FBA inventory

## Getting Started

[Add your existing getting started instructions here] 