/**
 * One-time script to normalize user emails in the database.
 * 
 * This script:
 * 1. Finds all users with duplicate emails (case-insensitive)
 * 2. Updates all duplicate records to use the password hash from the most recently created record
 * 3. Logs actions for auditing
 * 
 * Run with: npx tsx server/scripts/normalize-user-emails.ts
 * 
 * Options:
 *   --dry-run  Show what would be changed without making changes (default)
 *   --execute  Actually perform the changes
 */

import { db } from "../db";
import { users } from "@shared/schema";
import { sql, desc } from "drizzle-orm";

async function normalizeUserEmails() {
  const isDryRun = !process.argv.includes('--execute');
  
  console.log('='.repeat(60));
  console.log('User Email Normalization Script');
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE (changes will be applied)'}`);
  console.log('='.repeat(60));
  console.log('');
  
  // Find all duplicate emails (case-insensitive)
  const duplicateEmailsResult = await db.execute(sql`
    SELECT lower(email) as normalized_email, COUNT(*) as count
    FROM users
    GROUP BY lower(email)
    HAVING COUNT(*) > 1
    ORDER BY count DESC
  `);
  
  const duplicateEmails = duplicateEmailsResult.rows as Array<{ normalized_email: string; count: number }>;
  
  if (duplicateEmails.length === 0) {
    console.log('No duplicate emails found. Database is already normalized.');
    return;
  }
  
  console.log(`Found ${duplicateEmails.length} email(s) with duplicates:`);
  console.log('');
  
  for (const { normalized_email, count } of duplicateEmails) {
    console.log(`Email: ${normalized_email} (${count} records)`);
    
    // Get all users with this email, ordered by createdAt DESC (newest first)
    const usersWithEmail = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${normalized_email}`)
      .orderBy(desc(users.createdAt));
    
    console.log('  Records:');
    for (const user of usersWithEmail) {
      console.log(`    - ID: ${user.id}, Email: ${user.email}, Created: ${user.createdAt}`);
    }
    
    if (usersWithEmail.length < 2) continue;
    
    // The first record (most recent) is the canonical one
    const canonicalUser = usersWithEmail[0];
    const duplicateUsers = usersWithEmail.slice(1);
    
    console.log(`  Canonical record (most recent): ${canonicalUser.id}`);
    console.log(`  Will update ${duplicateUsers.length} duplicate(s) to use canonical password hash`);
    
    if (!isDryRun) {
      // Update all duplicates to use the canonical password hash
      for (const dupUser of duplicateUsers) {
        await db.execute(sql`
          UPDATE users 
          SET password = ${canonicalUser.password}
          WHERE id = ${dupUser.id}
        `);
        console.log(`    Updated user ${dupUser.id} with password from ${canonicalUser.id}`);
      }
    }
    
    console.log('');
  }
  
  console.log('='.repeat(60));
  if (isDryRun) {
    console.log('DRY RUN complete. Run with --execute to apply changes.');
    console.log('Command: npx tsx server/scripts/normalize-user-emails.ts --execute');
  } else {
    console.log('EXECUTE complete. All duplicate user passwords have been synchronized.');
    console.log('Users can now log in with their most recently set password.');
  }
  console.log('='.repeat(60));
}

normalizeUserEmails()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
