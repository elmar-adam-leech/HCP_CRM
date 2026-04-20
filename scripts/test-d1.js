// Simple test script to check D1 connectivity
const { d1Client } = require('../server/d1-client.ts');

async function testD1() {
  try {
    console.log('Testing D1 connectivity...');
    
    // Check if we can connect
    const isConnected = await d1Client.checkConnection();
    if (!isConnected) {
      console.error('❌ D1 connection failed');
      return;
    }
    console.log('✅ D1 connection successful');
    
    // Initialize schema
    await d1Client.initializeSchema();
    console.log('✅ D1 schema initialized');
    
    // Test a simple query
    const result = await d1Client.query('SELECT name FROM sqlite_master WHERE type="table"');
    console.log('✅ D1 tables created:', result.result.map(r => r.name));
    
  } catch (error) {
    console.error('❌ D1 test failed:', error.message);
  }
}

testD1();