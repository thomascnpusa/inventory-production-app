// Unit conversion factors
const conversionFactors = {
    // Weight conversions
    weight: {
        kg_to_g: 1000,
        g_to_kg: 0.001,
        kg_to_lb: 2.20462,
        lb_to_kg: 0.453592,
        lb_to_oz: 16,
        oz_to_lb: 0.0625,
        g_to_oz: 0.035274,
        oz_to_g: 28.3495,
        g_to_mg: 1000,
        mg_to_g: 0.001,
        kg_to_mg: 1000000,
        mg_to_kg: 0.000001
    },
    // Volume conversions
    volume: {
        L_to_mL: 1000,
        mL_to_L: 0.001,
        L_to_fl_oz: 33.814,
        fl_oz_to_L: 0.0295735,
        gal_to_L: 3.78541,
        L_to_gal: 0.264172,
        mL_to_fl_oz: 0.033814,
        fl_oz_to_mL: 29.5735
    }
};

// Unit categories with standardized names
const unitCategories = {
    weight: ['kg', 'g', 'lb', 'oz', 'mg', 'gram', 'grams', 'kilogram', 'kilograms', 'milligram', 'milligrams', 'ounce', 'ounces', 'pound', 'pounds'],
    volume: ['L', 'mL', 'fl_oz', 'gal', 'liter', 'liters', 'milliliter', 'milliliters', 'gallon', 'gallons', 'fluid_ounce', 'fluid_ounces'],
    count: ['units', 'pieces', 'count', 'unit', 'piece', 'ea', 'each']
};

// Unit standardization mapping
const unitStandardization = {
    // Weight units
    'gram': 'g',
    'grams': 'g',
    'kilogram': 'kg',
    'kilograms': 'kg',
    'milligram': 'mg',
    'milligrams': 'mg',
    'ounce': 'oz',
    'ounces': 'oz',
    'pound': 'lb',
    'pounds': 'lb',
    // Volume units
    'liter': 'L',
    'liters': 'L',
    'milliliter': 'mL',
    'milliliters': 'mL',
    'fluid_ounce': 'fl_oz',
    'fluid_ounces': 'fl_oz',
    'gallon': 'gal',
    'gallons': 'gal',
    // Count units
    'piece': 'units',
    'pieces': 'units',
    'unit': 'units',
    'ea': 'units',
    'each': 'units',
    'count': 'units'
};

// Normalize unit string
function normalizeUnit(unit) {
    if (!unit) return null;
    const normalized = unit.toLowerCase().replace(/[\s_]/g, '_');
    return unitStandardization[normalized] || normalized;
}

// Get unit category
function getUnitCategory(unit) {
    const normalizedUnit = normalizeUnit(unit);
    if (!normalizedUnit) return null;

    for (const [category, units] of Object.entries(unitCategories)) {
        if (units.some(u => normalizeUnit(u) === normalizedUnit)) {
            return category;
        }
    }
    return null;
}

// Convert between units
function convert(value, fromUnit, toUnit) {
    if (!value || isNaN(value)) {
        throw new Error('Invalid value for conversion');
    }

    if (!fromUnit || !toUnit) {
        throw new Error('Both fromUnit and toUnit must be specified');
    }

    const normalizedFromUnit = normalizeUnit(fromUnit);
    const normalizedToUnit = normalizeUnit(toUnit);

    if (!normalizedFromUnit || !normalizedToUnit) {
        throw new Error(`Invalid unit format: ${fromUnit} or ${toUnit}`);
    }

    if (normalizedFromUnit === normalizedToUnit) {
        return value;
    }

    // Handle count units
    if (unitCategories.count.some(u => normalizeUnit(u) === normalizedFromUnit) && 
        unitCategories.count.some(u => normalizeUnit(u) === normalizedToUnit)) {
        return value;
    }

    // Get conversion category
    const fromCategory = getUnitCategory(normalizedFromUnit);
    const toCategory = getUnitCategory(normalizedToUnit);
    
    if (!fromCategory || !toCategory) {
        throw new Error(`Unsupported unit(s): ${fromUnit} and/or ${toUnit}`);
    }
    
    if (fromCategory !== toCategory) {
        throw new Error(`Cannot convert between different categories: ${fromCategory} and ${toCategory}`);
    }

    // Convert to base unit first (kg for weight, L for volume)
    let baseValue;
    if (fromCategory === 'weight') {
        baseValue = convertToBaseWeight(value, normalizedFromUnit);
        return convertFromBaseWeight(baseValue, normalizedToUnit);
    } else if (fromCategory === 'volume') {
        baseValue = convertToBaseVolume(value, normalizedFromUnit);
        return convertFromBaseVolume(baseValue, normalizedToUnit);
    }

    throw new Error(`Unsupported unit conversion from ${fromUnit} to ${toUnit}`);
}

// Helper functions for weight conversions
function convertToBaseWeight(value, fromUnit) {
    switch (fromUnit) {
        case 'kg': return value;
        case 'g': return value * conversionFactors.weight.g_to_kg;
        case 'lb': return value * conversionFactors.weight.lb_to_kg;
        case 'oz': return value * conversionFactors.weight.oz_to_lb * conversionFactors.weight.lb_to_kg;
        case 'mg': return value * conversionFactors.weight.mg_to_kg;
        default: throw new Error(`Unsupported weight unit: ${fromUnit}`);
    }
}

function convertFromBaseWeight(value, toUnit) {
    switch (toUnit) {
        case 'kg': return value;
        case 'g': return value * conversionFactors.weight.kg_to_g;
        case 'lb': return value * conversionFactors.weight.kg_to_lb;
        case 'oz': return value * conversionFactors.weight.kg_to_lb * conversionFactors.weight.lb_to_oz;
        case 'mg': return value * conversionFactors.weight.kg_to_mg;
        default: throw new Error(`Unsupported weight unit: ${toUnit}`);
    }
}

// Helper functions for volume conversions
function convertToBaseVolume(value, fromUnit) {
    switch (fromUnit) {
        case 'l':
        case 'L': return value;
        case 'ml':
        case 'mL': return value * conversionFactors.volume.mL_to_L;
        case 'fl_oz': return value * conversionFactors.volume.fl_oz_to_L;
        case 'gal': return value * conversionFactors.volume.gal_to_L;
        default: throw new Error(`Unsupported volume unit: ${fromUnit}`);
    }
}

function convertFromBaseVolume(value, toUnit) {
    switch (toUnit) {
        case 'l':
        case 'L': return value;
        case 'ml':
        case 'mL': return value * conversionFactors.volume.L_to_mL;
        case 'fl_oz': return value * conversionFactors.volume.L_to_fl_oz;
        case 'gal': return value * conversionFactors.volume.L_to_gal;
        default: throw new Error(`Unsupported volume unit: ${toUnit}`);
    }
}

// Check if units are compatible (can be converted between each other)
function areUnitsCompatible(unit1, unit2) {
    if (!unit1 || !unit2) return false;
    
    const normalizedUnit1 = normalizeUnit(unit1);
    const normalizedUnit2 = normalizeUnit(unit2);
    
    if (!normalizedUnit1 || !normalizedUnit2) return false;
    
    const category1 = getUnitCategory(normalizedUnit1);
    const category2 = getUnitCategory(normalizedUnit2);
    
    return category1 && category2 && category1 === category2;
}

module.exports = {
    convert,
    getUnitCategory,
    unitCategories,
    normalizeUnit,
    areUnitsCompatible
};