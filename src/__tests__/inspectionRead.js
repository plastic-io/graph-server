const {inspectionRead}=require('../iac/inspectionRead');
function clock(){let time=0;return {now:()=>time,random:()=>0.5,sleep:jest.fn(async ms=>{time+=ms;})};}
test('temporary read errors retry within a bounded budget and preserve successful evidence',async()=>{
 const timer=clock(),call=jest.fn().mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'),{code:'Throttling'})).mockResolvedValue({Role:{RoleId:'same-role'}});
 expect(await inspectionRead(call,18000,timer)).toEqual({value:{Role:{RoleId:'same-role'}},attempts:2});
 expect(timer.sleep).toHaveBeenCalledWith(250);
});
test.each(['AccessDenied','NoSuchEntity','ValidationError','UnknownEndpoint'])('%s is not retried as a transient read',async code=>{
 const timer=clock(),error=Object.assign(new Error('original evidence'),{code}),call=jest.fn().mockRejectedValue(error);
 await expect(inspectionRead(call,18000,timer)).rejects.toBe(error);expect(call).toHaveBeenCalledTimes(1);expect(timer.sleep).not.toHaveBeenCalled();
});
test('repeated throttles stop at three attempts and retain the original failure',async()=>{
 const timer=clock(),error=Object.assign(new Error('Rate exceeded'),{code:'Throttling'}),call=jest.fn().mockRejectedValue(error);
 await expect(inspectionRead(call,18000,timer)).rejects.toBe(error);expect(call).toHaveBeenCalledTimes(3);expect(error.inspectionAttempts).toBe(3);
});
test('a retry cannot consume the remaining request deadline',async()=>{
 const timer=clock(),error=Object.assign(new Error('Rate exceeded'),{code:'Throttling'}),call=jest.fn().mockRejectedValue(error);
 await expect(inspectionRead(call,5100,timer)).rejects.toBe(error);expect(call).toHaveBeenCalledTimes(1);expect(timer.sleep).not.toHaveBeenCalled();
});
