// Hand-drawn, code-native pixel scenery. The actual interactive node sits in
// the open square; these houses are scenery, not additional graph nodes.
export default function PixelTown(){
  return <g shapeRendering="crispEdges" className="pixel-town">
    <path d="M-46-53H32v8h24v16h12v47H48v12H-40V20h-25v-48h9v-17h10z" fill="#91ad7838"/>
    <path d="M-7-34H5V-5H45V5H5v20H-7V5h-36V-5h36z" fill="#c9b58b"/>
    <path d="M-5-32H3V-3H43V3H3v20H-5V3h-36V-3h36z" fill="#ead7aa"/>
    <path d="M-15-12h28v23h-28z" fill="#d6c49d"/>
    <path d="M-12-9h22v17h-22z" fill="#eee0bf"/>
    <path d="M-9-5h6v2h-6zM1 2h6v2H1zM-38-2h5v2h-5zM19-2h5v2h-5zM-3-24h2v5h-2z" fill="#c0ac86"/>
    {/* Terracotta cottage, with a chimney and a sunlit gable. */}
    <g transform="translate(-51 -43)">
      <path d="M1 26h30v4H1z" fill="#52604438"/>
      <path d="M5 12h22v15H5z" fill="#755c46"/>
      <path d="M7 13h18v12H7z" fill="#edcf96"/>
      <path d="M20 0h4v11h-4z" fill="#775b49"/>
      <path d="M12 2h8v3h4v3h4v4h3v4H1v-4h3V8h4V5h4z" fill="#704d40"/>
      <path d="M12 4h8v3h4v3h3v3H5v-3h3V7h4z" fill="#b76446"/>
      <path d="M11 6h9v2h-9zM7 10h18v2H7z" fill="#d68b5b"/>
      <path d="M10 18h5v7h-5zM19 17h4v4h-4z" fill="#655c4e"/>
      <path d="M20 18h2v2h-2z" fill="#f7e8b8"/>
    </g>
    {/* Taller blue-roof inn and a striped market awning. */}
    <g transform="translate(8 -59)">
      <path d="M0 33h33v4H0z" fill="#52604438"/>
      <path d="M5 12h23v21H5z" fill="#6b6551"/>
      <path d="M7 13h19v18H7z" fill="#f0dbac"/>
      <path d="M12 0h8v3h4v4h4v4h4v4H0v-4h4V7h4V3h4z" fill="#365e63"/>
      <path d="M12 3h8v3h4v4h4v2H4v-2h4V6h4z" fill="#56898a"/>
      <path d="M11 5h9v2h-9zM7 10h17v2H7z" fill="#83aaa1"/>
      <path d="M10 17h4v5h-4zM19 17h4v5h-4zM14 25h6v8h-6z" fill="#655b49"/>
      <path d="M2 23h28v5H2z" fill="#ae5f47"/>
      <path d="M5 23h4v5H5zM13 23h4v5h-4zM21 23h4v5h-4z" fill="#f4e2bb"/>
      <path d="M2 28h2v6H2zM28 28h2v6h-2z" fill="#79664c"/>
    </g>
    <g transform="translate(37 -17)">
      <path d="M0 26h27v4H0z" fill="#52604438"/>
      <path d="M4 12h20v15H4z" fill="#776348"/>
      <path d="M6 13h16v12H6z" fill="#e2c18c"/>
      <path d="M8 3h12v4h4v4h3v5H0v-5h4V7h4z" fill="#805c3d"/>
      <path d="M8 5h12v4h4v4H3v-3h5z" fill="#bd934e"/>
      <path d="M8 7h11v2H8zM5 11h18v2H5z" fill="#e0b76d"/>
      <path d="M9 19h5v8H9zM18 18h3v4h-3z" fill="#6a624b"/>
    </g>
    {/* Orchard trees and a short fence give the settlement an edge. */}
    {[-56,25].map((x,i)=><g key={x} transform={`translate(${x} ${i?19:-3})`}>
      <path d="M-3 10h8v4h-8z" fill="#59614333"/>
      <path d="M0 0h3v12H0z" fill="#806247"/>
      <path d="M-4-9h10v3h4V3H6v4H-4V3h-3v-9h3z" fill="#527650"/>
      <path d="M-3-8h8v3h3v5H-3z" fill="#80a065"/>
      <path d="M-2-6h4v3h-4z" fill="#a5b777"/>
    </g>)}
    <path d="M-43 20h28v2h-28zM-41 16h2v10h-2zM-31 16h2v10h-2zM-21 16h2v10h-2z" fill="#ae9570"/>
  </g>;
}
