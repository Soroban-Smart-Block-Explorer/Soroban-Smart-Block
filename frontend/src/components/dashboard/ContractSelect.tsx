import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

interface Props {
  contractId: string;
  functionFilter: string;
  onContractChange: (id: string) => void;
  onFunctionChange: (fn: string) => void;
}

/** Contract + function-name selector, reused by webhook creation (registry-backed). */
export default function ContractSelect({ contractId, functionFilter, onContractChange, onFunctionChange }: Props) {
  const contractsQuery = useQuery({
    queryKey: ["dashboard", "contracts-for-select"],
    queryFn: () => api.listContractsSearch({ limit: 100 }),
  });

  const contractDetailQuery = useQuery({
    queryKey: ["dashboard", "contract-functions", contractId],
    queryFn: () => api.contract(contractId),
    enabled: !!contractId,
  });

  return (
    <>
      <select
        value={contractId}
        onChange={(e) => {
          onContractChange(e.target.value);
          onFunctionChange(""); // reset function filter when contract changes
        }}
      >
        <option value="">All contracts</option>
        {contractsQuery.data?.contracts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name || c.id}
          </option>
        ))}
      </select>

      <select value={functionFilter} onChange={(e) => onFunctionChange(e.target.value)} disabled={!contractId}>
        <option value="">All functions</option>
        {contractDetailQuery.data?.functions.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
      </select>
    </>
  );
}
