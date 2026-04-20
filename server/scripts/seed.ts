import { db, pool } from '../db';
import { users, contractors, userContractors } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';

async function seed() {
  try {
    let contractorId: string;
    let userId: string;

    // Check if admin user already exists
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, 'admin@example.com'))
      .limit(1);

    if (existingUser.length > 0 && existingUser[0].contractorId) {
      console.log('Admin user already exists with a contractor. Skipping.');
      return;
    }

    // Create a default contractor
    console.log('Creating default contractor...');
    const [contractor] = await db
      .insert(contractors)
      .values({
        name: 'Default Company',
        domain: 'default.local',
      })
      .returning();

    contractorId = contractor.id;
    console.log(`Contractor created: ${contractorId}`);

    if (existingUser.length > 0) {
      // User exists but has no contractor — update it
      console.log('Updating existing admin user with contractor...');
      userId = existingUser[0].id;
      await db
        .update(users)
        .set({ contractorId })
        .where(eq(users.id, userId));
    } else {
      // Create fresh admin user
      // WARNING: Do NOT run this script in production without setting SEED_ADMIN_PASSWORD
      // to a strong, randomly generated value. The default is only safe for local dev.
      console.log('Creating admin user...');
      const seedPassword = process.env.SEED_ADMIN_PASSWORD ?? 'changeme-local';
      const hashedPassword = await bcrypt.hash(seedPassword, 10);
      const [user] = await db
        .insert(users)
        .values({
          username: 'admin',
          password: hashedPassword,
          name: 'Admin User',
          email: 'admin@example.com',
          role: 'super_admin',
          contractorId,
        })
        .returning();
      userId = user.id;
      console.log(`User created: ${userId}`);
    }

    // Link user to contractor in user_contractors table
    const existingLink = await db
      .select()
      .from(userContractors)
      .where(eq(userContractors.userId, userId))
      .limit(1);

    if (existingLink.length === 0) {
      console.log('Linking user to contractor...');
      await db.insert(userContractors).values({
        userId,
        contractorId,
        role: 'super_admin',
        canManageIntegrations: true,
      });
    }

    console.log('');
    console.log('Seed complete! Sign in with:');
    console.log('  Email:    admin@example.com');
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  } finally {
    await (pool as any).end();
  }
}

seed();
