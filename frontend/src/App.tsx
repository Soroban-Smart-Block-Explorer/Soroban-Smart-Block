import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import Nav from "./components/Nav";
import ErrorBoundary from "./components/ErrorBoundary";

const Home = lazy(() => import("./pages/Home"));
const RegistryPage = lazy(() => import("./pages/RegistryPage"));
const RegisterContractPage = lazy(() => import("./pages/RegisterContractPage"));
const ContractPage = lazy(() => import("./pages/ContractPage"));
const WalletPage = lazy(() => import("./pages/WalletPage"));
const EventPage = lazy(() => import("./pages/EventPage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const XdrInspector = lazy(() => import("./pages/XdrInspector"));
const RpcMetricsDashboard = lazy(() => import("./pages/RpcMetricsDashboard"));
const GraphPage = lazy(() => import("./pages/GraphPage"));
const Sandbox = lazy(() => import("./pages/Sandbox"));
const SharedSandbox = lazy(() => import("./pages/SharedSandbox"));
const DeveloperWorkspace = lazy(() => import("./pages/DeveloperWorkspace"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const BatchMultiCall = lazy(() => import("./pages/BatchMultiCall"));
const SubInvocationPage = lazy(() => import("./pages/SubInvocationPage"));
const RateLimitDashboard = lazy(() => import("./pages/RateLimitDashboard"));
const NftGallery = lazy(() => import("./pages/NftGallery"));
const RegisterContractPage = lazy(() => import("./pages/RegisterContractPage"));

function Fallback() {
  return <p style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>Loading…</p>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Nav />
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>
        <Suspense fallback={<Fallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/contracts" element={<RegistryPage />} />
            <Route path="/contracts/register" element={<RegisterContractPage />} />
            <Route path="/contract/:id" element={<ContractPage />} />
            <Route path="/contract/:id/workspace" element={<DeveloperWorkspace />} />
            <Route path="/wallet/:address" element={<WalletPage />} />
            <Route path="/event/:seq" element={<EventPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/xdr" element={<XdrInspector />} />
            <Route path="/rpc-metrics" element={<RpcMetricsDashboard />} />
            <Route path="/graph" element={<GraphPage />} />
            <Route path="/sandbox" element={<Sandbox />} />
            <Route path="/sandbox/:id" element={<SharedSandbox />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/batch" element={<BatchMultiCall />} />
            <Route path="/sub-invocations" element={<SubInvocationPage />} />
            <Route path="/admin/rate-limits" element={<RateLimitDashboard />} />
            <Route path="/nft/:contractId" element={<NftGallery />} />
          </Routes>
        </Suspense>
      </main>
    </ErrorBoundary>
  );
}
