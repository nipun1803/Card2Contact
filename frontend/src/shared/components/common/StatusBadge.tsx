import { Badge } from "@/shared/components/ui/badge";

interface StatusBadgeProps {
  disabled: boolean;
}

/**
 * Active/Revoked status pill. Reused in both the User Directory table and the
 * User Details page header — the only reason this is a dedicated component
 * rather than inline.
 */
export function StatusBadge({ disabled }: StatusBadgeProps) {
  return disabled ? (
    <Badge variant="warning">Revoked</Badge>
  ) : (
    <Badge variant="success">Active</Badge>
  );
}
