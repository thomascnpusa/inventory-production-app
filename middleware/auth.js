const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const pgPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

// User roles and their permissions
const ROLES = {
    ADMIN: 'admin',
    MANAGER: 'manager',
    PRODUCTION_STAFF: 'production_staff'
};

const PERMISSIONS = {
    [ROLES.ADMIN]: ['*'], // All permissions
    [ROLES.MANAGER]: [
        'create_mmr',
        'update_mmr',
        'view_mmr',
        'create_production_order',
        'view_production_order',
        'create_inventory',
        'update_inventory',
        'view_inventory',
        'delete_inventory',
        'view_sales',
        'manage_sales',
        'view_reports'
    ],
    [ROLES.PRODUCTION_STAFF]: [
        'view_mmr',
        'view_production_order',
        'complete_production_step',
        'view_inventory',
        'update_inventory'
    ]
};

// Authentication middleware
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const result = await pgPool.query(
            'SELECT u.*, us.session_token FROM Users u JOIN UserSessions us ON u.id = us.user_id WHERE u.id = $1 AND us.session_token = $2 AND us.expires_at > NOW() AND u.is_active = true',
            [decoded.userId, token]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.user = result.rows[0];
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

// Role-based access control middleware
const checkPermission = (requiredPermission) => {
    return (req, res, next) => {
        const userRole = req.user.role;
        const userPermissions = PERMISSIONS[userRole];

        if (!userPermissions) {
            return res.status(403).json({ error: 'Invalid user role' });
        }

        if (userPermissions.includes('*') || userPermissions.includes(requiredPermission)) {
            next();
        } else {
            res.status(403).json({ error: 'Insufficient permissions' });
        }
    };
};

// User management functions
const createUser = async (username, email, password, role) => {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pgPool.query(
        'INSERT INTO Users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role',
        [username, email, hashedPassword, role]
    );
    return result.rows[0];
};

const loginUser = async (username, password) => {
    console.log('Login attempt for user:', username);
    const result = await pgPool.query(
        'SELECT * FROM Users WHERE username = $1 AND is_active = true',
        [username]
    );
    console.log('Database query result:', result.rows);

    if (result.rows.length === 0) {
        console.log('User not found');
        throw new Error('Invalid credentials');
    }

    const user = result.rows[0];
    console.log('Found user:', { ...user, password_hash: '[REDACTED]' });
    const validPassword = await bcrypt.compare(password, user.password_hash);
    console.log('Password valid:', validPassword);

    if (!validPassword) {
        console.log('Invalid password');
        throw new Error('Invalid credentials');
    }

    // Create session token
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
    console.log('Generated token:', token);
    
    // Store session
    await pgPool.query(
        'INSERT INTO UserSessions (user_id, session_token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'24 hours\')',
        [user.id, token]
    );
    console.log('Session stored');

    // Update last login
    await pgPool.query(
        'UPDATE Users SET last_login = NOW() WHERE id = $1',
        [user.id]
    );
    console.log('Last login updated');

    return {
        token,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
        }
    };
};

const logoutUser = async (token) => {
    await pgPool.query(
        'DELETE FROM UserSessions WHERE session_token = $1',
        [token]
    );
};

module.exports = {
    ROLES,
    PERMISSIONS,
    authenticateToken,
    checkPermission,
    createUser,
    loginUser,
    logoutUser
}; 