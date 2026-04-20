import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Clock } from "lucide-react";

const PRESET_VALUES = [30, 60, 90, 180];

const PRESET_OPTIONS = [
  { value: "none", label: "None (show all)" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "custom", label: "Custom" },
];

export function EstimateArchiveCard() {
  const { toast } = useToast();
  const [customDays, setCustomDays] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  const { data, isLoading } = useQuery<{ estimateArchiveDays: number | null }>({
    queryKey: ["/api/settings/estimate-archive"],
  });

  const currentValue = data?.estimateArchiveDays;

  const isCustomValue = currentValue !== null && currentValue !== undefined && !PRESET_VALUES.includes(currentValue);

  const selectValue = (() => {
    if (currentValue === null || currentValue === undefined) return "none";
    if (PRESET_VALUES.includes(currentValue)) return String(currentValue);
    return "custom";
  })();

  useEffect(() => {
    if (isCustomValue) {
      setShowCustom(true);
      setCustomDays(String(currentValue));
    }
  }, [isCustomValue, currentValue]);

  const mutation = useMutation({
    mutationFn: async (days: number | null) => {
      const res = await apiRequest("PATCH", "/api/settings/estimate-archive", {
        estimateArchiveDays: days,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/estimate-archive"] });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates/paginated"] });
      toast({ title: "Estimate archive setting updated" });
    },
    onError: () => {
      toast({ title: "Failed to update setting", variant: "destructive" });
    },
  });

  const handleSelectChange = (value: string) => {
    if (value === "custom") {
      setShowCustom(true);
      setCustomDays(currentValue ? String(currentValue) : "");
      return;
    }
    setShowCustom(false);
    const days = value === "none" ? null : parseInt(value, 10);
    mutation.mutate(days);
  };

  const handleCustomSave = () => {
    const days = parseInt(customDays, 10);
    if (isNaN(days) || days < 1) {
      toast({ title: "Enter a valid number of days (1 or more)", variant: "destructive" });
      return;
    }
    mutation.mutate(days);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Estimate Active Window</CardTitle>
        </div>
        <CardDescription>
          Hide older estimates from the default list view. Archived estimates are not deleted and can be shown anytime via the "Show all" toggle on the Estimates page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium">Show estimates from the last</label>
          <Select
            value={showCustom ? "custom" : selectValue}
            onValueChange={handleSelectChange}
            disabled={isLoading || mutation.isPending}
          >
            <SelectTrigger className="w-full max-w-xs" data-testid="select-archive-days">
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              {PRESET_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {showCustom && (
            <div className="flex items-center gap-2 max-w-xs">
              <Input
                type="number"
                min={1}
                placeholder="Number of days"
                value={customDays}
                onChange={(e) => setCustomDays(e.target.value)}
                data-testid="input-custom-archive-days"
              />
              <Button
                onClick={handleCustomSave}
                disabled={mutation.isPending}
                data-testid="button-save-custom-days"
              >
                Save
              </Button>
            </div>
          )}

          {currentValue && !showCustom && (
            <p className="text-xs text-muted-foreground">
              Currently showing estimates from the last {currentValue} days on the Estimates page.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
