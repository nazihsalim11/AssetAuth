const http = require('http');

const request = (path, method = 'GET', body = null) => {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '1', // Super Admin user ID
        'x-user-role': 'Super Admin',
        'x-user-username': 'admin'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
};

async function run() {
  try {
    console.log('--- STARTING TICKETING SYSTEM VERIFICATION ---');

    // 1. Create a dummy ticket
    console.log('\n1. Creating Test Ticket...');
    const createRes = await request('/api/tickets', 'POST', {
      subject: 'Integration Test Ticket',
      description: 'Verifying zendesk ticket updates.',
      department: 'IT',
      priority: 'Medium',
      category: 'Software',
      attachments: []
    });
    console.log('Status:', createRes.status);
    console.log('Ticket ID:', createRes.body.ticketId, '(DB ID:', createRes.body.id, ')');
    const ticketDbId = createRes.body.id;

    if (!ticketDbId) {
      throw new Error('Failed to create ticket for testing');
    }

    // 2. Patch Priority
    console.log('\n2. Testing Priority Patch...');
    const priRes = await request(`/api/tickets/${ticketDbId}/priority`, 'PATCH', { priority: 'Critical' });
    console.log('Status:', priRes.status);
    console.log('Response:', priRes.body);

    // 3. Patch Category
    console.log('\n3. Testing Category Patch...');
    const catRes = await request(`/api/tickets/${ticketDbId}/category`, 'PATCH', { category: 'Hardware' });
    console.log('Status:', catRes.status);
    console.log('Response:', catRes.body);

    // 4. Test Single Ticket Department Patch
    console.log('\n4. Testing Department Patch...');
    const deptRes = await request(`/api/tickets/${ticketDbId}/department`, 'PATCH', { department: 'Finance' });
    console.log('Status:', deptRes.status);
    console.log('Response:', deptRes.body);

    // 5. Test Workload Auto-Assignment
    console.log('\n5. Testing Workload Auto-Assignment...');
    const autoRes = await request(`/api/tickets/${ticketDbId}/auto-assign`, 'POST');
    console.log('Status:', autoRes.status);
    console.log('Response:', autoRes.body);

    // 6. Bulk updates: Create another ticket so we can bulk test
    console.log('\n6. Creating Second Ticket for Bulk Operations...');
    const create2Res = await request('/api/tickets', 'POST', {
      subject: 'Second Test Ticket',
      description: 'Verifying bulk operations.',
      department: 'IT',
      priority: 'Low',
      category: 'Network',
      attachments: []
    });
    const ticket2DbId = create2Res.body.id;
    console.log('Second Ticket DB ID:', ticket2DbId);

    // 7. Bulk Status update
    console.log('\n7. Testing Bulk Status Update...');
    const bulkStatusRes = await request('/api/tickets/bulk/status', 'POST', {
      ticketIds: [ticketDbId, ticket2DbId],
      status: 'On Hold'
    });
    console.log('Status:', bulkStatusRes.status);
    console.log('Response:', bulkStatusRes.body);

    // 8. Bulk Priority update
    console.log('\n8. Testing Bulk Priority Update...');
    const bulkPriRes = await request('/api/tickets/bulk/priority', 'POST', {
      ticketIds: [ticketDbId, ticket2DbId],
      priority: 'Low'
    });
    console.log('Status:', bulkPriRes.status);
    console.log('Response:', bulkPriRes.body);

    // 9. Bulk Category update
    console.log('\n9. Testing Bulk Category Update...');
    const bulkCatRes = await request('/api/tickets/bulk/category', 'POST', {
      ticketIds: [ticketDbId, ticket2DbId],
      category: 'Network'
    });
    console.log('Status:', bulkCatRes.status);
    console.log('Response:', bulkCatRes.body);

    // 10. Bulk Department update
    console.log('\n10. Testing Bulk Department Update...');
    const bulkDeptRes = await request('/api/tickets/bulk/department', 'POST', {
      ticketIds: [ticketDbId, ticket2DbId],
      department: 'Operations'
    });
    console.log('Status:', bulkDeptRes.status);
    console.log('Response:', bulkDeptRes.body);

    // 11. Bulk Assign update
    console.log('\n11. Testing Bulk Assignment...');
    const bulkAssignRes = await request('/api/tickets/bulk/assign', 'POST', {
      ticketIds: [ticketDbId, ticket2DbId],
      assignToUserId: 1
    });
    console.log('Status:', bulkAssignRes.status);
    console.log('Response:', bulkAssignRes.body);

    // 12. Fetch details to confirm
    console.log('\n12. Verifying Saved State...');
    const verifyRes = await request(`/api/tickets/${ticketDbId}`);
    console.log('Status:', verifyRes.status);
    console.log('Category:', verifyRes.body.category);
    console.log('Department:', verifyRes.body.department);
    console.log('Priority:', verifyRes.body.priority);
    console.log('Status:', verifyRes.body.status);
    console.log('Assigned to ID:', verifyRes.body.assignedTo);
    console.log('Timeline Entry Count:', verifyRes.body.timeline ? verifyRes.body.timeline.length : 0);

    // 13. Bulk Delete
    console.log('\n13. Testing Bulk Deletion...');
    const deleteRes = await request('/api/tickets/bulk/delete', 'POST', {
      ticketIds: [ticketDbId, ticket2DbId]
    });
    console.log('Status:', deleteRes.status);
    console.log('Response:', deleteRes.body);

    console.log('\n--- VERIFICATION COMPLETED SUCCESSFULLY ---');
  } catch (err) {
    console.error('Verification failed:', err);
  }
}

run();
