export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center" aria-busy="true" aria-label="Loading">
      <div className="w-64 space-y-3">
        <div className="skeleton h-10 w-10 rounded-xl mx-auto" />
        <div className="skeleton h-3 w-3/4 mx-auto" />
        <div className="skeleton h-3 w-1/2 mx-auto" />
      </div>
    </div>
  );
}
