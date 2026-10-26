const $ = s => document.querySelector(s);
let products = [];
let cart = JSON.parse(localStorage.getItem("syncoutfits_cart") || "[]");
let visitorId = localStorage.getItem("syncoutfits_visitor");
if (!visitorId) { visitorId = "v_" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)); localStorage.setItem("syncoutfits_visitor", visitorId); }
const naira = n => new Intl.NumberFormat("en-NG",{style:"currency",currency:"NGN",maximumFractionDigits:0}).format(n);
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove("show"),2600)}
function safe(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function loadProducts(){
  try { const r=await fetch("/api/products"); if(!r.ok)throw Error(); products=await r.json(); renderProducts(); }
  catch { $("#products").innerHTML='<div class="empty-state">The collection could not load right now. Please refresh shortly.</div>'; $("#product-total").textContent=""; }
}
function renderProducts(){
  $("#product-total").textContent=`${products.length} ${products.length===1?"PIECE":"PIECES"} IN THE DROP`;
  if(!products.length){$("#products").innerHTML='<div class="empty-state">The first drop is being prepared. Check back soon.</div>';return}
  $("#products").innerHTML=products.map(p=>{
    const price=p.salePrice!=null?p.salePrice:p.price, sale=p.salePrice!=null;
    const sizes=p.sizes?.length?p.sizes:[];
    const sizeUI=sizes.length?`<select class="size-select" id="size-${p.id}" aria-label="Choose size">${sizes.map(s=>`<option value="${safe(s)}">${safe(s)}</option>`).join("")}</select>`:"";
    const image=p.imageUrl||"https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=700&q=80";
    return `<article class="product-card"><div class="product-image"><img loading="lazy" src="${safe(image)}" alt="${safe(p.name)}">${sale?'<span class="product-tag">SALE</span>':""}${p.stock===0?'<span class="product-tag">SOLD OUT</span>':""}</div><div class="product-info"><div class="product-name">${safe(p.name)}</div><div class="product-desc">${safe(p.description||"SYNCOUTFITS essential.")}</div><div class="prices">${sale?`<span class="sale-price">${naira(price)}</span><span class="old-price">${naira(p.price)}</span>`:`<span>${naira(price)}</span>`}</div><div class="product-actions">${sizeUI}<button class="add-button" data-add="${p.id}" ${p.stock<1?"disabled":""}>${p.stock<1?"SOLD OUT":"ADD TO BAG +"}</button></div></div></article>`;
  }).join("");
}
function saveCart(){localStorage.setItem("syncoutfits_cart",JSON.stringify(cart));renderCart()}
async function addToCart(id){
  const p=products.find(x=>x.id===id); if(!p||p.stock<1)return;
  const sizeEl=$(`#size-${id}`),size=sizeEl?sizeEl.value:"";
  const existing=cart.find(x=>x.id===id&&x.size===size);
  const current=existing?.qty||0;
  if(current>=p.stock){toast("That is all the available stock.");return}
  if(existing)existing.qty++;else cart.push({id:p.id,name:p.name,price:p.salePrice??p.price,imageUrl:p.imageUrl,size,qty:1,stock:p.stock});
  saveCart();openCart();toast("Added to your bag.");
  try { await fetch("/api/cart-events",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({productId:p.id,quantity:1,size,visitorId})}); }
  catch(e){console.warn("Cart event notification did not send",e)}
}
function renderCart(){
  $("#cart-count").textContent=cart.reduce((n,x)=>n+x.qty,0);
  $("#cart-subtotal").textContent=naira(cart.reduce((n,x)=>n+x.price*x.qty,0));
  if(!cart.length){$("#cart-items").innerHTML='<div class="empty-state">Your bag is empty.</div>';return}
  $("#cart-items").innerHTML=cart.map(x=>`<div class="cart-row"><img src="${safe(x.imageUrl||"https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=200&q=80")}" alt=""><div><strong>${safe(x.name)}</strong><small>${x.size?`Size: ${safe(x.size)} · `:""}Qty: ${x.qty}</small><small>${naira(x.price)} each</small><button data-remove="${x.id}" data-size="${safe(x.size)}">REMOVE</button></div><strong>${naira(x.price*x.qty)}</strong></div>`).join("");
}
function openCart(){$("#cart-panel").classList.add("open");$("#cart-panel").setAttribute("aria-hidden","false");$("#scrim").classList.add("show")}
function closeCart(){$("#cart-panel").classList.remove("open");$("#cart-panel").setAttribute("aria-hidden","true");$("#scrim").classList.remove("show")}
$("#products").addEventListener("click",e=>{const b=e.target.closest("[data-add]");if(b)addToCart(Number(b.dataset.add))});
$("#cart-items").addEventListener("click",e=>{const b=e.target.closest("[data-remove]");if(b){cart=cart.filter(x=>!(x.id===Number(b.dataset.remove)&&x.size===b.dataset.size));saveCart()}});
$("#cart-open").addEventListener("click",openCart);$("#cart-close").addEventListener("click",closeCart);$("#scrim").addEventListener("click",closeCart);$("#cart-continue").addEventListener("click",closeCart);
$("#year").textContent=new Date().getFullYear();renderCart();loadProducts();
