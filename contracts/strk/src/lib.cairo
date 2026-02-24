#[starknet::interface]
trait IStrkToken<TContractState> {
    fn balance_of(ref self: TContractState, account: starknet::ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: starknet::ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
mod strk_token {
    use starknet::storage::{Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        total_supply: u256,
    }

    #[constructor]
    fn constructor(ref self: ContractState, initial_supply: u256, recipient: ContractAddress) {
        self.balances.entry(recipient).write(initial_supply);
        self.total_supply.write(initial_supply);
    }

    #[abi(embed_v0)]
    impl StrkTokenImpl of super::IStrkToken<ContractState> {
        fn balance_of(ref self: ContractState, account: ContractAddress) -> u256 {
            self.balances.entry(account).read()
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let sender = get_caller_address();
            let sender_balance = self.balances.entry(sender).read();
            assert(sender_balance >= amount, 'Insufficient balance');
            self.balances.entry(sender).write(sender_balance - amount);
            let recipient_balance = self.balances.entry(recipient).read();
            self.balances.entry(recipient).write(recipient_balance + amount);
            true
        }
    }
}
