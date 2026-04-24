// Read-only smoke test: prints the notes feed for an HCP estimate.
// Usage: npx tsx server/scripts/check-hcp-estimate-notes.ts <tenantId> <hcpEstimateId>
import { housecallProService } from "../hcp/index";

async function main(): Promise<void> {
  const [, , tenantId, estimateId] = process.argv;
  if (!tenantId || !estimateId) {
    console.error("Usage: npx tsx server/scripts/check-hcp-estimate-notes.ts <tenantId> <hcpEstimateId>");
    process.exit(2);
  }

  console.log(`Fetching notes for HCP estimate ${estimateId} (tenant ${tenantId})...`);
  const result = await housecallProService.getEstimateNotes(tenantId, estimateId);

  if (!result.success) {
    console.error(`FAILED: ${result.error ?? "unknown error"}`);
    process.exit(1);
  }

  const notes = result.data ?? [];
  if (notes.length === 0) {
    console.warn(`No notes returned for estimate ${estimateId}`);
    process.exit(1);
  }

  console.log(`Found ${notes.length} note(s):`);
  for (const n of notes) {
    const id = (n as { id?: string }).id ?? "<no-id>";
    const content = typeof n.content === "string" ? n.content : JSON.stringify(n.content);
    const preview = content.length > 200 ? `${content.slice(0, 200)}...` : content;
    console.log(`  - [${id}] ${preview}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
