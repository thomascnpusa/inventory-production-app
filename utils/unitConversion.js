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
        g_to_mg: 1000,      // Add g to mg
        mg_to_g: 0.001,     // Add mg to g
        kg_to_mg: 1000000,  // Add kg to mg
        mg_to_kg: 0.000001  // Add mg to kg
    },
    // Volume conversions
    volume: {
        L_to_mL: 1000,
        mL_to_L: 0.001,
        L_to_fl_oz: 33.814,
        fl_oz_to_L: 0.0295735,
        gal_to_L: 3.78541,
        L_to_gal: 0.264172
    }
};

// Unit categories
const unitCategories = {
    weight: ['kg', 'g', 'lb', 'oz', 'mg'], // Add mg
    volume: ['L', 'mL', 'fl oz', 'gal'],
    count: ['units', 'pieces', 'count']
};

// Get unit category
function getUnitCategory(unit) {
    unit = unit.toLowerCase().replace('_', ' ');
    for (const [category, units] of Object.entries(unitCategories)) {
        if (units.some(u => u.toLowerCase() === unit)) {
            return category;
        }
    }
    return null;
}

// Convert between units
function convert(value, fromUnit, toUnit) {
    if (fromUnit === toUnit) return value;
    
    fromUnit = fromUnit.toLowerCase().replace('_', ' ');
    toUnit = toUnit.toLowerCase().replace('_', ' ');

    // Handle count units
    if (unitCategories.count.includes(fromUnit) && unitCategories.count.includes(toUnit)) {
        return value; // No conversion needed for count units
    }

    // Get conversion category
    const category = getUnitCategory(fromUnit);
    if (!category || category !== getUnitCategory(toUnit)) {
        throw new Error(`Cannot convert between ${fromUnit} and ${toUnit}`);
    }

    // Convert to base unit first (kg for weight, L for volume)
    let baseValue;
    if (category === 'weight') {
        baseValue = convertToBaseWeight(value, fromUnit);
        return convertFromBaseWeight(baseValue, toUnit);
    } else if (category === 'volume') {
        baseValue = convertToBaseVolume(value, fromUnit);
        return convertFromBaseVolume(baseValue, toUnit);
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
        case 'mg': return value * conversionFactors.weight.mg_to_kg; // Add mg to kg
        default: throw new Error(`Unsupported weight unit: ${fromUnit}`);
    }
}

function convertFromBaseWeight(value, toUnit) {
    switch (toUnit) {
        case 'kg': return value;
        case 'g': return value * conversionFactors.weight.kg_to_g;
        case 'lb': return value * conversionFactors.weight.kg_to_lb;
        case 'oz': return value * conversionFactors.weight.kg_to_lb * conversionFactors.weight.lb_to_oz;
        case 'mg': return value * conversionFactors.weight.kg_to_mg; // Add kg to mg
        default: throw new Error(`Unsupported weight unit: ${toUnit}`);
    }
}

// Helper functions for volume conversions (unchanged)
function convertToBaseVolume(value, fromUnit) {
    switch (fromUnit) {
        case 'l': return value;
        case 'ml': return value * conversionFactors.volume.mL_to_L;
        case 'fl oz': return value * conversionFactors.volume.fl_oz_to_L;
        case 'gal': return value * conversionFactors.volume.gal_to_L;
        default: throw new Error(`Unsupported volume unit: ${fromUnit}`);
    }
}

function convertFromBaseVolume(value, toUnit) {
    switch (toUnit) {
        case 'l': return value;
        case 'ml': return value * conversionFactors.volume.L_to_mL;
        case 'fl oz': return value * conversionFactors.volume.L_to_fl_oz;
        case 'gal': return value * conversionFactors.volume.L_to_gal;
        default: throw new Error(`Unsupported volume unit: ${toUnit}`);
    }
}

module.exports = {
    convert,
    getUnitCategory,
    unitCategories
};