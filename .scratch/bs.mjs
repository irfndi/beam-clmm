const base="https://mainnet.base.org";
const rpc=async(url,m,p)=>(await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})})).json();
const pool="0xd0b53d9277642d899df5c87a3966a349a798f224";
const slot0="0x3850c7bd",tok0="0x0dfe1681",tok1="0xd21220a7",fee="0xddca3f43",liq="0x1a686502";
(async()=>{
  for(const [lbl,d] of [["slot0",slot0],["token0",tok0],["token1",tok1],["fee",fee],["liquidity",liq]]){
    const r=await rpc(base,"eth_call",[{to:pool,data:d},"latest"]);
    console.log(lbl+":", r.error? "ERR "+JSON.stringify(r.error).slice(0,80) : r.result.slice(0,34)+"...");
  }
})();
