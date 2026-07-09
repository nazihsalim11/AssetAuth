async function test() {
  try {
    const testUsername = 'testuser_' + Date.now();
    const testPassword = 'Password@123';
    const testEmail = testUsername + '@company.com';
    const testEmpId = 'EMP-' + Date.now().toString().slice(-4);

    // 1. Create the first user
    const createRes1 = await fetch('http://localhost:5000/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: testPassword,
        name: 'First User',
        role: 'Employee',
        email: testEmail,
        employeeId: testEmpId,
        phoneNumber: '+919876543210',
        department: 'Engineering',
        designation: 'Engineer',
        status: 'Active'
      })
    });

    console.log("Create user 1 status:", createRes1.status);
    const user1 = await createRes1.json();
    console.log("Create user 1 response:", user1);

    // 2. Try to create second user with different email but same prefix (so duplicate username)
    const duplicateEmail = testEmail.replace('@company.com', '@otherdomain.com').toUpperCase();
    const createRes2 = await fetch('http://localhost:5000/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: testPassword,
        name: 'Second User (Duplicate Username)',
        role: 'Employee',
        email: duplicateEmail,
        employeeId: 'EMP-DIFF',
        phoneNumber: '+919876543210',
        department: 'Engineering',
        designation: 'Engineer',
        status: 'Active'
      })
    });

    console.log("Create duplicate username status:", createRes2.status);
    const user2 = await createRes2.json();
    console.log("Create duplicate username response:", user2);

  } catch (err) {
    console.error("Test failed:", err);
  }
}

test();
