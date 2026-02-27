#[starknet::interface]
pub trait IYieldAdapter<T> {
    fn stake(ref self: T, amount: u128) -> bool;
    fn request_unstake(ref self: T, amount: u128) -> bool;
    fn claim_rewards(ref self: T) -> u128;
    fn staked_balance(self: @T) -> u128;
    fn pending_unstake(self: @T) -> u128;
}

#[starknet::contract]
pub mod mock_native_staking_adapter {
    use core::traits::TryInto;
    use starknet::get_block_timestamp;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::IYieldAdapter;

    const YEAR_SECONDS: u64 = 31_536_000;

    #[storage]
    struct Storage {
        staked: u128,
        pending: u128,
        apr_bps: u32,
        reward_reserve: u128,
        last_accrual_ts: u64,
    }

    #[constructor]
    fn constructor(ref self: ContractState, apr_bps: u32) {
        self.apr_bps.write(apr_bps);
        self.last_accrual_ts.write(get_block_timestamp());
    }

    fn accrue(ref self: ContractState) {
        let now = get_block_timestamp();
        let last = self.last_accrual_ts.read();
        if now <= last {
            return;
        }
        let staked = self.staked.read();
        if staked == 0 {
            self.last_accrual_ts.write(now);
            return;
        }
        let elapsed: u128 = (now - last).try_into().unwrap();
        let apr_u128: u128 = self.apr_bps.read().try_into().unwrap();
        let yearly_base = (staked / 10_000) * apr_u128;
        let earned = (yearly_base * elapsed) / (YEAR_SECONDS.try_into().unwrap());
        if earned > 0 {
            let reserve = self.reward_reserve.read();
            let credit = if earned < reserve { earned } else { reserve };
            self.reward_reserve.write(reserve - credit);
        }
        self.last_accrual_ts.write(now);
    }

    #[abi(embed_v0)]
    impl MockAdapterImpl of IYieldAdapter<ContractState> {
        fn stake(ref self: ContractState, amount: u128) -> bool {
            if amount == 0 {
                return false;
            }
            accrue(ref self);
            self.staked.write(self.staked.read() + amount);
            true
        }

        fn request_unstake(ref self: ContractState, amount: u128) -> bool {
            if amount == 0 {
                return false;
            }
            accrue(ref self);
            let current = self.staked.read();
            if amount > current {
                return false;
            }
            self.staked.write(current - amount);
            self.pending.write(self.pending.read() + amount);
            true
        }

        fn claim_rewards(ref self: ContractState) -> u128 {
            let before = self.reward_reserve.read();
            accrue(ref self);
            let after = self.reward_reserve.read();
            before - after
        }

        fn staked_balance(self: @ContractState) -> u128 {
            self.staked.read()
        }

        fn pending_unstake(self: @ContractState) -> u128 {
            self.pending.read()
        }
    }
}

#[starknet::contract]
pub mod official_native_staking_adapter {
    use core::array::SpanTrait;
    use core::traits::TryInto;
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use starknet::SyscallResultTrait;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::call_contract_syscall;
    use super::IYieldAdapter;

    #[starknet::interface]
    pub trait IOfficialNativeAdapterAdmin<T> {
        fn set_owner(ref self: T, owner: ContractAddress);
        fn set_config(
            ref self: T,
            staking_target: ContractAddress,
            token: ContractAddress,
            rewards_address: ContractAddress,
            operational_address: ContractAddress
        );
    }

    #[starknet::interface]
    pub trait IERC20<T> {
        fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
        fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        staking_target: ContractAddress,
        token: ContractAddress,
        rewards_address: ContractAddress,
        operational_address: ContractAddress,
        operational_declared: bool,
        staked_local: u128,
        unstake_intent_open: bool,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        staking_target: ContractAddress,
        token: ContractAddress,
        rewards_address: ContractAddress,
        operational_address: ContractAddress
    ) {
        self.owner.write(owner);
        self.staking_target.write(staking_target);
        self.token.write(token);
        self.rewards_address.write(rewards_address);
        self.operational_address.write(operational_address);
        self.operational_declared.write(false);
        self.staked_local.write(0);
        self.unstake_intent_open.write(false);
    }

    fn assert_owner(self: @ContractState) {
        assert!(get_caller_address() == self.owner.read(), "Only owner");
    }

    fn call_no_args_mut(self: @ContractState, selector: felt252) -> bool {
        let target = self.staking_target.read();
        if target.into() == 0 || selector == 0 {
            return false;
        }
        call_contract_syscall(target, selector, array![].span()).is_ok()
    }

    fn call_single_addr_u128_mut(
        ref self: ContractState,
        selector: felt252,
        addr: ContractAddress,
        amount: u128
    ) -> bool {
        let target = self.staking_target.read();
        if target.into() == 0 || selector == 0 {
            return false;
        }
        let mut calldata = array![];
        calldata.append(addr.into());
        calldata.append(amount.into());
        call_contract_syscall(target, selector, calldata.span()).is_ok()
    }

    fn call_claim_rewards(self: @ContractState) -> u128 {
        let target = self.staking_target.read();
        if target.into() == 0 {
            return 0;
        }
        let mut calldata = array![];
        calldata.append(get_contract_address().into());
        let result = call_contract_syscall(target, selector!("claim_rewards"), calldata.span());
        if result.is_err() {
            return 0;
        }
        let data = result.unwrap_syscall();
        if data.len() == 0 {
            return 0;
        }
        (*data.at(0)).try_into().unwrap_or(0)
    }

    fn call_unstake_action(self: @ContractState) -> u128 {
        let target = self.staking_target.read();
        if target.into() == 0 {
            return 0;
        }
        let mut calldata = array![];
        calldata.append(get_contract_address().into());
        let result = call_contract_syscall(target, selector!("unstake_action"), calldata.span());
        if result.is_err() {
            return 0;
        }
        let data = result.unwrap_syscall();
        if data.len() == 0 {
            return 0;
        }
        (*data.at(0)).try_into().unwrap_or(0)
    }

    fn call_declare_operational(self: @ContractState, staker: ContractAddress) -> bool {
        let target = self.staking_target.read();
        if target.into() == 0 {
            return false;
        }
        let mut calldata = array![];
        calldata.append(staker.into());
        call_contract_syscall(target, selector!("declare_operational_address"), calldata.span()).is_ok()
    }

    #[abi(embed_v0)]
    impl OfficialAdminImpl of IOfficialNativeAdapterAdmin<ContractState> {
        fn set_owner(ref self: ContractState, owner: ContractAddress) {
            assert_owner(@self);
            self.owner.write(owner);
        }

        fn set_config(
            ref self: ContractState,
            staking_target: ContractAddress,
            token: ContractAddress,
            rewards_address: ContractAddress,
            operational_address: ContractAddress
        ) {
            assert_owner(@self);
            self.staking_target.write(staking_target);
            self.token.write(token);
            self.rewards_address.write(rewards_address);
            self.operational_address.write(operational_address);
            self.operational_declared.write(false);
        }
    }

    #[abi(embed_v0)]
    impl OfficialAdapterImpl of IYieldAdapter<ContractState> {
        fn stake(ref self: ContractState, amount: u128) -> bool {
            if amount == 0 {
                return false;
            }
            let staking_target = self.staking_target.read();
            if staking_target.into() == 0 {
                return false;
            }
            // Native staking pulls STRK via transfer_from, so the adapter must approve first.
            let token = IERC20Dispatcher { contract_address: self.token.read() };
            let approved = token.approve(staking_target, u256 { low: amount, high: 0 });
            if !approved {
                return false;
            }
            let self_addr = get_contract_address();
            // Some native staking setups require operational address declaration before stake.
            if self.operational_address.read() == self_addr && !self.operational_declared.read() {
                if call_declare_operational(@self, self_addr) {
                    self.operational_declared.write(true);
                }
            }
            let increased = call_single_addr_u128_mut(ref self, selector!("increase_stake"), self_addr, amount);
            if increased {
                self.staked_local.write(self.staked_local.read() + amount);
                self.unstake_intent_open.write(false);
                return true;
            }

            let mut calldata = array![];
            calldata.append(self.rewards_address.read().into());
            calldata.append(self.operational_address.read().into());
            calldata.append(amount.into());
            let ok = call_contract_syscall(staking_target, selector!("stake"), calldata.span()).is_ok();
            if ok {
                self.staked_local.write(self.staked_local.read() + amount);
                self.unstake_intent_open.write(false);
            }
            ok
        }

        fn request_unstake(ref self: ContractState, amount: u128) -> bool {
            if amount == 0 {
                return false;
            }
            let staked = self.staked_local.read();
            if staked == 0 || amount < staked {
                return false;
            }

            let unstaked = call_unstake_action(@self);
            if unstaked > 0 {
                let token = IERC20Dispatcher { contract_address: self.token.read() };
                let caller = get_caller_address();
                let moved = token.transfer(caller, u256 { low: unstaked, high: 0 });
                if !moved {
                    return false;
                }
                self.staked_local.write(0);
                self.unstake_intent_open.write(false);
                return true;
            }

            let intent_ok = call_no_args_mut(@self, selector!("unstake_intent"));
            if intent_ok {
                self.unstake_intent_open.write(true);
            }
            false
        }

        fn claim_rewards(ref self: ContractState) -> u128 {
            call_claim_rewards(@self)
        }

        fn staked_balance(self: @ContractState) -> u128 {
            self.staked_local.read()
        }

        fn pending_unstake(self: @ContractState) -> u128 {
            if self.unstake_intent_open.read() { self.staked_local.read() } else { 0 }
        }
    }
}
