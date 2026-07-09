const db = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\db.js');
const bcrypt = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\node_modules\\bcryptjs');

async function check() {
  try {
    const testUsername = 'testuser_' + Date.now();
    const testPassword = 'Password@123';
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(testPassword, salt);
    
    console.log("Generated hash:", passwordHash);

    // Insert user
    const insertRes = await db.query(`
      INSERT INTO users (username, password_hash, name, role, email)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, username, password_hash;
    `, [testUsername, passwordHash, 'Test User', 'Employee', testUsername + '@company.com']);
    
    console.log("Inserted user:", insertRes.rows[0]);

    // Retrieve and compare
    const retrieveRes = await db.query('SELECT * FROM users WHERE username = $1', [testUsername]);
    const retrievedUser = retrieveRes.rows[0];
    
    console.log("Retrieved password hash:", retrievedUser.password_hash);
    
    const isMatch = await bcrypt.compare(testPassword, retrievedUser.password_hash);
    console.log("Password comparison result:", isMatch);
  } catch (err) {
    console.error("Test failed:", err);
  } finally {
    process.exit(0);
  }
}

check();
