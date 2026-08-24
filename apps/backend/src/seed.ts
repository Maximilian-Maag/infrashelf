import { runBootstrap } from './lib/bootstrap';

async function main() {
  try {
    await runBootstrap();
    console.warn('[seed] Database seeded successfully.');
    process.exit(0);
  } catch (error) {
    console.error('[seed] Error seeding database:', error);
    process.exit(1);
  }
}

// `void`, not a bare call: main() handles both outcomes itself and exits, so
// there is nothing left to await — say so rather than leave a dangling promise.
void main();
