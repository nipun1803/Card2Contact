import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "@/shared/components/common/DataTable";

interface Row {
  id: string;
  name: string;
}

const COLUMNS: DataTableColumn<Row>[] = [
  { key: "name", header: "Name", sortField: "name", render: (r) => r.name },
];

describe("DataTable", () => {
  it("renders one row per item", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[{ id: "1", name: "Ada" }, { id: "2", name: "Grace" }]}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
  });

  it("renders skeleton rows while loading, not the empty state", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        loading
        emptyState={<div>EMPTY</div>}
      />,
    );
    expect(screen.queryByText("EMPTY")).not.toBeInTheDocument();
  });

  it("renders the emptyState when rows is empty and not loading", () => {
    render(
      <DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} emptyState={<div>EMPTY</div>} />,
    );
    expect(screen.getByText("EMPTY")).toBeInTheDocument();
  });

  it("clicking a sortable header fires onSortChange with that column's sortField", async () => {
    const onSortChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DataTable
        columns={COLUMNS}
        rows={[{ id: "1", name: "Ada" }]}
        rowKey={(r) => r.id}
        sortField="name"
        sortDirection="asc"
        onSortChange={onSortChange}
      />,
    );

    await user.click(screen.getByText("Name"));

    expect(onSortChange).toHaveBeenCalledWith("name");
  });
});
