import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { HcpLineItem } from "@shared/schema";

type LineItemsTableProps = {
  items: HcpLineItem[] | null | undefined;
};

type HcpServiceItemDetail = {
  id: string;
  name?: string;
  description?: string;
  unit_price?: number;
  unit_cost?: number;
  taxable?: boolean;
  kind?: string;
  sku?: string;
  category?: string;
  updated_at?: string;
};

function ServiceItemDetail({ serviceItemId }: { serviceItemId: string }) {
  const { data, isLoading, error } = useQuery<HcpServiceItemDetail>({
    queryKey: ["/api/housecall-pro/service-items", serviceItemId],
    enabled: !!serviceItemId,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="service-item-loading">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="service-item-error">
        Could not load catalog details from Housecall Pro.
      </p>
    );
  }

  if (!data) return null;

  const priceDollars =
    typeof data.unit_price === "number" ? data.unit_price / 100 : null;
  const costDollars =
    typeof data.unit_cost === "number" ? data.unit_cost / 100 : null;

  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm" data-testid="service-item-detail">
      {data.sku && (
        <>
          <dt className="text-muted-foreground">SKU</dt>
          <dd className="col-span-2 font-mono">{data.sku}</dd>
        </>
      )}
      {data.kind && (
        <>
          <dt className="text-muted-foreground">Kind</dt>
          <dd className="col-span-2 capitalize">{data.kind}</dd>
        </>
      )}
      {data.category && (
        <>
          <dt className="text-muted-foreground">Category</dt>
          <dd className="col-span-2">{data.category}</dd>
        </>
      )}
      {priceDollars != null && (
        <>
          <dt className="text-muted-foreground">Catalog Price</dt>
          <dd className="col-span-2 tabular-nums">{formatCurrency(priceDollars)}</dd>
        </>
      )}
      {costDollars != null && (
        <>
          <dt className="text-muted-foreground">Cost</dt>
          <dd className="col-span-2 tabular-nums">{formatCurrency(costDollars)}</dd>
        </>
      )}
      {typeof data.taxable === "boolean" && (
        <>
          <dt className="text-muted-foreground">Taxable</dt>
          <dd className="col-span-2">{data.taxable ? "Yes" : "No"}</dd>
        </>
      )}
      {data.description && (
        <>
          <dt className="text-muted-foreground">Description</dt>
          <dd className="col-span-2 whitespace-pre-wrap">{data.description}</dd>
        </>
      )}
    </dl>
  );
}

export function LineItemsTable({ items }: LineItemsTableProps) {
  const [selected, setSelected] = useState<HcpLineItem | null>(null);

  if (!items || items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="text-line-items-empty">
        No line items captured yet.
      </p>
    );
  }

  return (
    <>
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
            {items.map((item) => {
              const hasCatalog = !!item.service_item_id;
              return (
                <tr
                  key={item.id}
                  className={`border-t ${hasCatalog ? "cursor-pointer hover-elevate" : ""}`}
                  onClick={hasCatalog ? () => setSelected(item) : undefined}
                  data-testid={`row-line-item-${item.id}`}
                  aria-label={hasCatalog ? `View catalog details for ${item.name}` : undefined}
                  role={hasCatalog ? "button" : undefined}
                  tabIndex={hasCatalog ? 0 : undefined}
                  onKeyDown={
                    hasCatalog
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelected(item);
                          }
                        }
                      : undefined
                  }
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0">
                        <div className="font-medium">{item.name}</div>
                        {item.description && (
                          <div className="text-xs text-muted-foreground">{item.description}</div>
                        )}
                      </div>
                      {hasCatalog && (
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                    </div>
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
              );
            })}
          </tbody>
        </table>
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-md" data-testid="sheet-line-item-detail">
          <SheetHeader>
            <SheetTitle>{selected?.name || "Line item"}</SheetTitle>
            <SheetDescription>
              Housecall Pro catalog details for this line item.
            </SheetDescription>
          </SheetHeader>

          {selected && (
            <div className="mt-6 space-y-6">
              <section className="space-y-2">
                <h3 className="text-sm font-medium">On this {selected.kind === "discount" ? "discount" : "line"}</h3>
                <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Quantity</dt>
                  <dd className="col-span-2 tabular-nums">{selected.quantity}</dd>
                  <dt className="text-muted-foreground">Unit Price</dt>
                  <dd className="col-span-2 tabular-nums">{formatCurrency(selected.unit_price)}</dd>
                  <dt className="text-muted-foreground">Total</dt>
                  <dd className="col-span-2 tabular-nums font-medium">{formatCurrency(selected.total)}</dd>
                  {selected.description && (
                    <>
                      <dt className="text-muted-foreground">Description</dt>
                      <dd className="col-span-2 whitespace-pre-wrap">{selected.description}</dd>
                    </>
                  )}
                </dl>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Catalog entry</h3>
                {selected.service_item_id ? (
                  <ServiceItemDetail serviceItemId={selected.service_item_id} />
                ) : (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="service-item-missing"
                  >
                    This line item is not linked to a Housecall Pro catalog entry.
                  </p>
                )}
              </section>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
