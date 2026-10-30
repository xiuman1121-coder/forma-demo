// 火山方舟图片生成公开刊例价，2026-10-09 核对。
// 实际账单可能受赠送额度、折扣和供应商后续调价影响。
export const IMAGE_MODEL='doubao-seedream-5-0-flash-260915';
export const IMAGE_LIST_PRICE_FEN=12;
export const IMAGE_PRICE_SOURCE='https://docs.volcengine.com/docs/82379/1544106?lang=zh';
export function imageReserveFen(env={}){
 const configured=Number(env.ARK_IMAGE_RESERVE_FEN);
 return Number.isSafeInteger(configured)&&configured>=IMAGE_LIST_PRICE_FEN?configured:IMAGE_LIST_PRICE_FEN;
}
