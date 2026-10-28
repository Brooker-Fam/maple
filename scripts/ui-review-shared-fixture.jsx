import {useState} from "react";
import {createRoot} from "react-dom/client";
import {AppNavProvider,useAppNav} from "../src/components/maple/AppNav";
import HelpSheet from "../src/components/maple/HelpSheet";
import {Button,Sheet,Segmented} from "../src/components/maple/ui";
function App(){
 const nav=useAppNav();
 const [open,setOpen]=useState(false);
 const [help,setHelp]=useState(false);
 const [child,setChild]=useState(false);
 const [text,setText]=useState("");
 const [value,setValue]=useState("one");
 return <main className="mx-auto max-w-md space-y-4 p-6">
 <h1>Synthetic shared UI</h1><output aria-label="Current page">{nav.tab}/{nav.seg}</output>
 <nav>{["today","care","history","moments","family"].map(x=><Button key={x} onClick={()=>nav.go(x)}>{x}</Button>)}</nav>
 <Button onClick={()=>nav.setSeg("patterns")}>View patterns</Button>
 <Button onClick={()=>setHelp(true)}>Open help</Button><HelpSheet open={help} onClose={()=>setHelp(false)}/>
 <Segmented aria-label="Example choice" value={value} onChange={setValue} options={[{value:"one",label:"One"},{value:"two",label:"Two"},{value:"three",label:"Three"}]}/>
 <Button onClick={()=>{setText("");setOpen(true)}}>Open form</Button>
 <Sheet open={open} dirty={!!text} onClose={()=>setOpen(false)} title="Example form" footer={<Button onClick={()=>setOpen(false)}>Save</Button>}>
 <label>Example draft<input value={text} onChange={e=>setText(e.target.value)} /></label>
 <Button onClick={()=>setChild(true)}>Open child</Button>
 <Sheet open={child} onClose={()=>setChild(false)} title="Child"><p>Child content</p></Sheet>
 </Sheet>
 <div id="contrast" style={{color:"var(--mp-ink-3)",background:"var(--mp-bg)"}}>Small text</div>
 </main>
}
createRoot(document.getElementById("root")).render(<AppNavProvider><App/></AppNavProvider>);
