# Database Migrations

This directory contains SQL migration files for database schema changes.

## Migration Process

1. Create a new SQL file with a descriptive name (e.g., `add_column_to_table.sql`)
2. Include both the SQL statements and comments explaining the changes
3. Apply the migration manually to the database
4. Commit the migration file to the repository for documentation

## Recent Migrations

- `add_updated_at_to_productionorders.sql` - Adds the missing `updated_at` column to the productionorders table 