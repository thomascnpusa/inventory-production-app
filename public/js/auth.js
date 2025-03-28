// Check if user is authenticated
function isAuthenticated() {
    const token = localStorage.getItem('token');
    console.log('Checking authentication, token exists:', !!token);
    if (!token) return false;

    try {
        // Check if token is expired
        const payload = JSON.parse(atob(token.split('.')[1]));
        const isExpired = payload.exp * 1000 < Date.now();
        console.log('Token expiration check:', { 
            exp: new Date(payload.exp * 1000), 
            now: new Date(), 
            isExpired 
        });
        if (isExpired) {
            console.log('Token is expired, removing from storage');
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            return false;
        }
        return true;
    } catch (error) {
        console.error('Error checking authentication:', error);
        return false;
    }
}

// Get authentication token
function getToken() {
    const token = localStorage.getItem('token');
    console.log('Getting token from storage:', !!token);
    if (!token) {
        console.log('No token found, redirecting to login');
        window.location.href = '/login.html';
        return null;
    }
    return token;
}

// Get current user
function getCurrentUser() {
    const userStr = localStorage.getItem('user');
    console.log('Getting user from storage:', !!userStr);
    if (!userStr) {
        console.log('No user found, redirecting to login');
        window.location.href = '/login.html';
        return null;
    }
    const user = JSON.parse(userStr);
    console.log('Current user:', { username: user.username, role: user.role });
    return user;
}

// Check authentication and role permissions
async function checkAuth(allowedRoles = []) {
    console.log('Checking auth with allowed roles:', allowedRoles);
    
    if (!isAuthenticated()) {
        console.log('Not authenticated, redirecting to login');
        window.location.href = '/login.html';
        return null;
    }
    
    const user = getCurrentUser();
    if (!user) {
        console.log('No user data found, redirecting to login');
        window.location.href = '/login.html';
        return null;
    }
    
    // If allowedRoles is provided, check if the user has permission
    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        console.error('User does not have required role:', user.role, 'Required:', allowedRoles);
        alert('You do not have permission to access this page.');
        window.location.href = '/index.html';
        return null;
    }
    
    console.log('User authorized:', user.username, user.role);
    return user;
}

// Add authentication headers to fetch options
function addAuthHeader(options = {}) {
    const token = getToken();
    if (!token) {
        console.log('No token available for auth header');
        return null;
    }

    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    };

    const mergedOptions = {
        ...defaultOptions,
        ...options,
        headers: {
            ...defaultOptions.headers,
            ...options.headers
        }
    };
    console.log('Auth headers added:', mergedOptions.headers);
    return mergedOptions;
}

// Authenticated fetch wrapper
async function authenticatedFetch(url, options = {}) {
    console.log('Making authenticated request to:', url);
    if (!isAuthenticated()) {
        console.log('Not authenticated, redirecting to login');
        window.location.href = '/login.html';
        return null;
    }

    const authOptions = addAuthHeader(options);
    if (!authOptions) {
        console.log('Failed to add auth headers');
        return null;
    }

    try {
        console.log('Sending request with options:', {
            method: authOptions.method || 'GET',
            headers: authOptions.headers
        });
        const response = await fetch(url, authOptions);
        console.log('Response received:', {
            status: response.status,
            ok: response.ok,
            statusText: response.statusText
        });
        
        if (response.status === 401) {
            console.log('Unauthorized response, clearing auth data');
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/login.html';
            return null;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
        }

        return response;
    } catch (error) {
        console.error('Fetch error:', error);
        throw error;
    }
}

// Logout function
async function logout() {
    try {
        await authenticatedFetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
        console.error('Logout error:', error);
    } finally {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login.html';
    }
}

// Setup user info in the navbar
function setupUserInfo() {
    // Check for both old and new user info elements
    const userInfoElement = document.getElementById('userInfo');
    const usernameDisplayElement = document.getElementById('usernameDisplay');
    
    const user = getCurrentUser();
    if (user) {
        // Update both possible elements
        if (userInfoElement) {
            userInfoElement.textContent = `${user.username} (${user.role})`;
        }
        if (usernameDisplayElement) {
            usernameDisplayElement.textContent = `${user.username} (${user.role})`;
        }
    }
}

// Setup navbar visibility based on user role
function setupNavbarVisibility() {
    const user = getCurrentUser();
    if (!user) return;
    
    // Show admin links if user is admin
    const adminElements = document.querySelectorAll('.admin-only');
    if (user.role === 'admin') {
        adminElements.forEach(el => {
            el.style.display = 'block';
        });
    }
    
    // Add click event to logout button
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }
}

// Setup all page elements on load
function setupPage() {
    setupUserInfo();
    setupNavbarVisibility();
}

// Check authentication on page load
document.addEventListener('DOMContentLoaded', function() {
    if (!isAuthenticated() && window.location.pathname !== '/login.html') {
        window.location.href = '/login.html';
    } else {
        setupPage();
    }
}); 