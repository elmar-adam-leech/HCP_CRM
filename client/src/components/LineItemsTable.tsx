import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import type { HcpLineItem } from "@shared/schema";

type LineItemsTableProps = {
  items: HcpLineItem[] | null | undefined;
};

export function LineItemsTable({ items }: LineItemsTableProps) {
  if (!items || items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="text-line-items-empty">
        No line items captured yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border" data-testid="table-line-items">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium text-right">Qty</th>
            <th className="px-3 py-2 font-medium text-right">Unit Price</th>
            <th className="px-3 py-2 font-medium text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t" data-testid={`row-line-item-${item.id}`}>
              <td className="px-3 py-2">
                <div className="font-medium">{item.name}</div>
                {item.description && (
                  <div className="text-xs text-muted-foreground">{item.description}</div>
                )}
              </td>
              <td className="px-3 py-2">
                {item.kind ? (
                  <Badge variant="secondary" className="capitalize">{item.kind}</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{item.quantity}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(item.unit_price)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-medium">{formatCurrency(item.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
