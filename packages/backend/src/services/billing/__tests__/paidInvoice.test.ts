import {it,expect} from 'bun:test';
import {readOwnedPaidInvoice} from '../paidInvoice';
import type {StripeBillingClient} from '../stripeBillingProvider';
const expected={invoiceId:'in_one',subscriptionId:'sub_one',customerId:'cus_one',priceId:'price_one',storeId:'payer',planId:'one@1',livemode:false};
function fixture(){
 const invoice={id:'in_one',customer:'cus_one',livemode:false,status:'paid',pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,currency:'usd',total:2999,amount_paid:2999,amount_due:2999,amount_remaining:0,total_excluding_tax:2500,parent:{type:'subscription_details',subscription_details:{subscription:'sub_one'}}};
 const line={id:'il_one',invoice:'in_one',livemode:false,subscription:'sub_one',quantity:1,amount:2500,parent:{type:'subscription_item_details',subscription_item_details:{subscription:'sub_one',proration:false}},pricing:{price_details:{price:'price_one'}},period:{start:1791028800,end:1793707200}};
 const payment={id:'inpay_one',invoice:'in_one',livemode:false,currency:'usd',status:'paid',amount_paid:2999,payment:{type:'payment_intent',payment_intent:'pi_one'},status_transitions:{paid_at:1791028800}};
 const intent={id:'pi_one',customer:'cus_one',livemode:false,currency:'usd',status:'succeeded',amount_received:2999,latest_charge:{id:'ch_one',payment_intent:'pi_one',customer:'cus_one',currency:'usd',livemode:false,paid:true,captured:true,amount_captured:2999,amount_refunded:0,refunded:false,disputed:false}};
 const lines={has_more:false,data:[line]},payments={has_more:false,data:[payment]};
 const client={retrieveInvoice:async()=>invoice,listInvoiceLines:async()=>lines,listInvoicePayments:async()=>payments,retrievePaidPaymentIntent:async()=>intent} as unknown as StripeBillingClient;
 return {invoice,line,payment,intent,lines,payments,client};
}
it('projects exact full paid line with actual provider net/tax and no PII',async()=>{const f=fixture();expect(await readOwnedPaidInvoice(f.client,expected)).toMatchObject({invoiceId:'in_one',lineId:'il_one',amountPaid:'2999',netAmount:'2500',taxAmount:'499',storeId:'payer',planId:'one@1'});f.invoice.total_excluding_tax=null as unknown as number;expect(await readOwnedPaidInvoice(f.client,expected)).toMatchObject({netAmount:null,taxAmount:null});});
it('rejects unrelated customer/subscription/price, partial/prorated/refunded/disputed/unpaid evidence and incomplete pages',async()=>{
 for(const mutate of ([(f:ReturnType<typeof fixture>)=>f.invoice.customer='cus_other',f=>f.invoice.parent.subscription_details.subscription='sub_other',f=>f.line.pricing.price_details.price='price_other',f=>f.invoice.amount_paid=100,f=>f.invoice.post_payment_credit_notes_amount=1,f=>f.line.parent.subscription_item_details.proration=true,f=>f.intent.latest_charge.amount_refunded=1,f=>f.intent.latest_charge.disputed=true,f=>f.intent.status='processing',f=>f.lines.has_more=true,f=>f.payments.data=[],f=>f.payment.payment.type='payment_record'] satisfies Array<(f:ReturnType<typeof fixture>)=>void>)){const f=fixture();mutate(f);await expect(readOwnedPaidInvoice(f.client,expected)).rejects.toThrow();}
});
it('rejects root changes during bounded evidence read',async()=>{const f=fixture();let reads=0;f.client.retrieveInvoice=async()=>({...f.invoice,amount_paid:++reads===1?2999:1});await expect(readOwnedPaidInvoice(f.client,expected)).rejects.toThrow();});
